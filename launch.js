'use strict';

/* One-window launcher: local server + Cloudflare Quick Tunnel. */

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8080);
const LOCAL = `http://127.0.0.1:${PORT}`;
const CLOUDFLARED = path.join(ROOT, 'tools', 'cloudflared.exe');
const URL_FILE = path.join(ROOT, 'tunnel-url.txt');
const DEBUG = process.env.DEBUG === '1';

let serverChild = null;
let tunnelChild = null;
let tunnelUrl = '';
let tunnelTimer = null;
let shuttingDown = false;
let fallbackStarted = false;
let tunnelSource = '';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkHealth(timeout) {
  return new Promise((resolve) => {
    const req = http.get(`${LOCAL}/health`, { timeout: timeout || 1500 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(res.statusCode === 200 && !!data.ok);
        } catch (err) {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitForServer(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await checkHealth(1200)) return true;
    await sleep(350);
  }
  return false;
}

function checkPublic(url, timeout) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const req = https.get(`${url}/health`, { timeout: timeout || 7000 }, (res) => {
      res.resume();
      done(res.statusCode === 200);
    });
    req.on('error', () => done(false));
    req.on('timeout', () => { req.destroy(); done(false); });
  });
}

function openBrowser(url) {
  try {
    const child = spawn('cmd', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
  } catch (err) { /* browser is optional */ }
}

function line() {
  console.log('  ' + '─'.repeat(62));
}

async function onTunnelReady(url, source) {
  tunnelUrl = url;
  tunnelSource = source || '';
  clearTimeout(tunnelTimer);
  const base = url.replace(/\/+$/, '');
  const shareUrl = /serveo/i.test(tunnelSource)
    ? `${base}/?serveo-skip-browser-warning=true`
    : base;
  line();
  console.log('');
  console.log('  公网链接已经生成，手机和电脑都能打开：');
  console.log('');
  console.log(`  ${shareUrl}`);
  console.log('');
  console.log(`  本机地址   ${LOCAL}`);
  console.log('  房间语音   需要这个 HTTPS 链接，浏览器才会给麦克风权限');
  console.log('  链接寿命   本次运行期间有效；关窗口、关机或重启后会变化');
  if (source) console.log(`  通道来源   ${source}`);
  if (shareUrl !== base) console.log('  首次打开   会自动跳过隧道提示页，直接进入游戏');
  console.log('');
  line();
  console.log('');
  try {
    fs.writeFileSync(URL_FILE, `${shareUrl}\n`, 'utf8');
  } catch (err) { /* ignore */ }

  let ok = false;
  for (let i = 0; i < 5; i += 1) {
    await sleep(i === 0 ? 1600 : 1800);
    ok = await checkPublic(base);
    if (ok) break;
  }
  if (ok) {
    console.log('  [ok] 公网链路已连通，正在打开浏览器。');
  } else {
    console.log('  [..] 公网链路还在生效，稍等十几秒再刷新页面。');
  }
  console.log('');
  openBrowser(shareUrl);
}

function extractTunnelUrl(text, pattern, blockedHosts) {
  const re = new RegExp(pattern, 'ig');
  let match;
  while ((match = re.exec(text))) {
    try {
      const host = new URL(match[0]).hostname.toLowerCase();
      if (!blockedHosts.includes(host)) return match[0];
    } catch (err) { /* keep looking */ }
  }
  return '';
}

function startServeo(reason) {
  if (fallbackStarted) return;
  fallbackStarted = true;
  clearTimeout(tunnelTimer);
  if (tunnelChild && tunnelChild.exitCode == null) {
    try { tunnelChild.kill(); } catch (err) { /* ignore */ }
  }
  if (reason) console.log(`  [..] ${reason}`);
  console.log('  正在切换 serveo 备用通道（无需账号）…');

  tunnelChild = spawn('ssh', [
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=4',
    '-o', 'TCPKeepAlive=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-R', `80:localhost:${PORT}`,
    'serveo.net'
  ], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const seen = new Set();
  const handle = (buf) => {
    const text = buf.toString('utf8');
    if (DEBUG) process.stdout.write(text);
    if (!tunnelUrl) {
      const url = extractTunnelUrl(text, 'https:\\/\\/[a-z0-9][a-z0-9-]*\\.serveousercontent\\.com', []);
      if (url) onTunnelReady(url, 'serveo · SSH');
    }
    if (!DEBUG) {
      text.split(/\r?\n/).forEach((raw) => {
        const msg = raw.trim();
        if (!msg || msg.includes('serveousercontent.com')) return;
        if (!/ERR|error|failed|WARN|denied/i.test(msg)) return;
        if (seen.has(msg)) return;
        seen.add(msg);
        console.error(`  [tunnel] ${msg.slice(0, 220)}`);
      });
    }
  };
  tunnelChild.stdout.on('data', handle);
  tunnelChild.stderr.on('data', handle);

  tunnelChild.on('error', (err) => {
    console.error(`  serveo 启动失败：${err.message}`);
    console.error('  请确认 Windows 已安装 OpenSSH 客户端，并检查网络。');
    shutdown(1);
  });
  tunnelChild.on('exit', (code) => {
    if (shuttingDown) return;
    console.error(`  serveo 通道已退出（代码 ${code == null ? '?' : code}）。`);
    console.error('  检查网络后重新运行 start-server.cmd。');
    shutdown(1);
  });

  tunnelTimer = setTimeout(() => {
    if (tunnelUrl || shuttingDown) return;
    console.error('');
    console.error('  25 秒内没拿到备用公网链接。');
    console.error('  本机地址仍然可用：' + LOCAL);
    shutdown(1);
  }, 25000);
}

function startTunnel() {
  if (process.env.FORCE_SERVEO === '1') {
    startServeo('已指定使用 serveo 备用通道。');
    return;
  }
  if (!fs.existsSync(CLOUDFLARED)) {
    startServeo('没有找到 cloudflared.exe，跳过 Cloudflare。');
    return;
  }
  console.log('  正在向 Cloudflare 申请临时公网链接…');
  tunnelChild = spawn(CLOUDFLARED, [
    'tunnel',
    '--url', LOCAL,
    '--protocol', 'http2',
    '--edge-ip-version', '4',
    '--no-autoupdate',
    '--loglevel', 'info'
  ], {
    cwd: ROOT,
    windowsHide: true,
    env: { ...process.env, GODEBUG: 'http2client=0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const seen = new Set();
  const handle = (buf) => {
    const text = buf.toString('utf8');
    if (DEBUG) process.stdout.write(text);
    if (!tunnelUrl) {
      const url = extractTunnelUrl(
        text,
        'https:\\/\\/[a-z0-9][a-z0-9.-]*\\.trycloudflare\\.com',
        ['api.trycloudflare.com', 'www.trycloudflare.com']
      );
      if (url) {
        onTunnelReady(url, 'Cloudflare Quick Tunnel');
        return;
      }
    }
    if (!tunnelUrl && /failed to request quick Tunnel|quick tunnel provisioning failed|status 429/i.test(text)) {
      startServeo('Cloudflare 快速隧道限流或超时，切换备用通道。');
      return;
    }
    if (!DEBUG) {
      text.split(/\r?\n/).forEach((raw) => {
        const msg = raw.trim();
        if (!msg || msg.includes('trycloudflare.com')) return;
        if (!/ERR|error|failed|WARN/i.test(msg)) return;
        if (seen.has(msg)) return;
        seen.add(msg);
        console.error(`  [tunnel] ${msg.slice(0, 220)}`);
      });
    }
  };
  tunnelChild.stdout.on('data', handle);
  tunnelChild.stderr.on('data', handle);

  tunnelChild.on('error', (err) => {
    startServeo(`cloudflared 启动失败（${err.message}），切换备用通道。`);
  });
  tunnelChild.on('exit', (code) => {
    if (shuttingDown || fallbackStarted) return;
    startServeo(`cloudflared 已退出（代码 ${code == null ? '?' : code}），切换备用通道。`);
  });

  tunnelTimer = setTimeout(() => {
    if (tunnelUrl || shuttingDown) return;
    startServeo('25 秒内没拿到 Cloudflare 链接，切换备用通道。');
  }, 25000);
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(tunnelTimer);
  try {
    if (tunnelChild && tunnelChild.exitCode == null) tunnelChild.kill();
  } catch (err) { /* ignore */ }
  try {
    if (serverChild && serverChild.exitCode == null) serverChild.kill();
  } catch (err) { /* ignore */ }
  setTimeout(() => process.exit(code == null ? 0 : code), 500);
}

async function main() {
  console.log('');
  line();
  console.log('  骗子酒馆 · NEON  //  本机服务器 + 公网房间');
  line();
  console.log('');

  const already = await checkHealth();
  if (already) {
    console.log('  检测到 8080 端口已有房间服务，直接复用它。');
  } else {
    console.log('  正在启动房间服务…');
    serverChild = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true
    });
    serverChild.on('error', (err) => {
      console.error(`  房间服务启动失败：${err.message}`);
      shutdown(1);
    });
    serverChild.on('exit', (code) => {
      if (shuttingDown) return;
      console.error(`  房间服务已退出（代码 ${code == null ? '?' : code}）。`);
      shutdown(1);
    });
    const ok = await waitForServer(12000);
    if (!ok) {
      console.error('');
      console.error('  房间服务没有按时起来。检查上面的报错，或端口 8080 是否被占用。');
      shutdown(1);
      return;
    }
    console.log('  [ok] 房间服务已就绪。');
  }

  console.log('');
  startTunnel();
}

process.on('SIGINT', () => {
  console.log('\n  正在关闭房间与公网链接…');
  shutdown(0);
});
process.on('SIGTERM', () => shutdown(0));
process.on('SIGHUP', () => shutdown(0));

main().catch((err) => {
  console.error(err);
  shutdown(1);
});

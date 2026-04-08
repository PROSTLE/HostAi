/**
 * tunnel.js — Public URL tunneling.
 * Priority: Cloudflare quick tunnel (cloudflared) -> Pinggy SSH fallback.
 */
import { spawn } from 'child_process';

let tunnelProcess = null;
let publicUrl = null;
let activeProvider = null;

function setPublicUrl(url, provider) {
  publicUrl = url?.replace('http://', 'https://') || null;
  activeProvider = publicUrl ? provider : null;
}

function wireAutoRestart(port) {
  if (!tunnelProcess) return;
  tunnelProcess.on('close', () => {
    console.log('⚠️  Tunnel closed. Restarting...');
    setPublicUrl(null, null);
    setTimeout(() => {
      startTunnel(port).catch(() => {});
    }, 3000);
  });
}

function startCloudflareTunnel(port) {
  return new Promise((resolve) => {
    console.log('🌐 Starting public tunnel (Cloudflare)...');

    let settled = false;
    tunnelProcess = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate']);

    const finish = (url) => {
      if (settled) return;
      settled = true;
      if (url) {
        setPublicUrl(url, 'cloudflare');
        console.log(`🌍 PUBLIC URL: ${publicUrl}`);
      }
      resolve(publicUrl);
    };

    const handleOutput = (data) => {
      const output = data.toString();
      const match = output.match(/https:\/\/[\w.-]+\.trycloudflare\.com/);
      if (match) finish(match[0]);
    };

    tunnelProcess.stdout.on('data', handleOutput);
    tunnelProcess.stderr.on('data', handleOutput);

    tunnelProcess.on('error', () => finish(null));
    setTimeout(() => finish(null), 15000);
  });
}

function startPinggyTunnel(port) {
  return new Promise((resolve) => {
    console.log('🌐 Starting public tunnel (Pinggy fallback)...');

    let settled = false;
    tunnelProcess = spawn('ssh', [
      '-p', '443',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=30',
      '-R0:localhost:' + port,
      'a.pinggy.io',
    ]);

    const finish = (url) => {
      if (settled) return;
      settled = true;
      if (url) {
        setPublicUrl(url, 'pinggy');
        console.log(`🌍 PUBLIC URL: ${publicUrl}`);
      }
      resolve(publicUrl);
    };

    const handleOutput = (data) => {
      const output = data.toString();
      const match = output.match(/(https?:\/\/[^\s]+\.pinggy(-free)?\.link)/);
      if (match) finish(match[0]);
    };

    tunnelProcess.stdout.on('data', handleOutput);
    tunnelProcess.stderr.on('data', handleOutput);
    tunnelProcess.on('error', () => finish(null));

    setTimeout(() => finish(null), 15000);
  });
}

/**
 * Start a public tunnel to expose the local server.
 */
export async function startTunnel(port) {
  if (tunnelProcess) {
    try { tunnelProcess.kill(); } catch {}
    tunnelProcess = null;
  }
  setPublicUrl(null, null);

  const cloudflareUrl = await startCloudflareTunnel(port);
  if (cloudflareUrl) {
    wireAutoRestart(port);
    return cloudflareUrl;
  }

  const pinggyUrl = await startPinggyTunnel(port);
  if (pinggyUrl) {
    wireAutoRestart(port);
    return pinggyUrl;
  }

  console.log('❌ Tunnel failed: cloudflared and pinggy unavailable.');
  console.log('   Sites will be available on localhost only.\n');
  return null;
}

/**
 * Get the public URL for a hosted site
 */
export function getSitePublicURL(siteId) {
  const base = publicUrl || `http://localhost:${process.env.PORT || 3000}`;
  return `${base}/site/${siteId}/`;
}

/**
 * Get the current base public URL
 */
export function getBasePublicURL() {
  return publicUrl || `http://localhost:${process.env.PORT || 3000}`;
}

/**
 * Get info about the tunnel status
 */
export function getTunnelInfo() {
  return {
    active: !!publicUrl,
    publicUrl: publicUrl,
    provider: activeProvider,
    localUrl: `http://localhost:${process.env.PORT || 3000}`,
  };
}

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';

function launch(command, args) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  return new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('无法启动浏览器，请确认系统已安装可用的浏览器。')));
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export async function openBrowser(url) {
  const target = new URL(url);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port ||
      target.username || target.password || target.pathname !== '/' || target.search || !target.hash) {
    throw new Error('聊天窗口地址无效。');
  }

  if (process.platform === 'win32') {
    for (const root of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]) {
      if (!root) continue;
      const edge = path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
      try {
        await access(edge);
        await launch(edge, [`--app=${target.href}`, '--window-size=560,720']);
        return;
      } catch {
        // Use the next Edge installation or the system browser.
      }
    }
    const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe');
    await launch(shell, ['url.dll,FileProtocolHandler', target.href]);
    return;
  }

  await launch(process.platform === 'darwin' ? 'open' : 'xdg-open', [target.href]);
}

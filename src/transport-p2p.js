/**
 * 可选 P2P 直连传输适配器（按需动态加载 hyperswarm，不作为强制依赖）
 */
export async function createHyperswarm({ seed }) {
  let mod;
  try {
    mod = await import('hyperswarm');
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.code === 'MODULE_NOT_FOUND') {
      throw new Error(
        '当前未安装可选直连模块 hyperswarm。默认零依赖模式请使用 transport="relay"；如需启用点对点直连并支持发送 2MB 大图，请先执行 `npm install hyperswarm` 或改用 `npx -y -p humanwire-mcp -p hyperswarm humanwire-mcp --transport p2p` 启动。'
      );
    }
    throw err;
  }

  const Hyperswarm = mod.default || mod;
  return new Hyperswarm({ seed });
}

// @common/rendererIpc 替身。
// 落雪在渲染进程通过 IPC 调主进程做歌词解密；MusicHub 后端一期不做歌词，
// 这里提供会抛错的桩，只有真正调用到才会报错，不影响榜单/歌单。
export const rendererInvoke = async () => {
  throw new Error('rendererInvoke 在 MusicHub 后端不可用（未实现歌词解密）');
};

export const sendRendererInvoke = rendererInvoke;

export default { rendererInvoke };

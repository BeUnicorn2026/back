export const maximumBufferedAudioBytes = 16_000 * 2 * 5;

export function canForwardLiveAudio(socket, maximumBytes = maximumBufferedAudioBytes) {
  return socket?.readyState === 1 && Number(socket.bufferedAmount || 0) <= maximumBytes;
}

// Documento offscreen (Chrome): service workers não acessam a área de transferência.
// Substitui o conteúdo copiado por texto vazio usando o evento "copy".
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'custodia:offscreen-clear') return false;
  const onCopy = e => {
    e.clipboardData.setData('text/plain', '');
    e.preventDefault();
  };
  document.addEventListener('copy', onCopy);
  const ok = document.execCommand('copy');
  document.removeEventListener('copy', onCopy);
  sendResponse({ ok });
  return false;
});

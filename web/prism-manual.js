/* Before Prism loads: it colours nothing by itself, and listens to no worker message.
   The chat asks it for a token tree (Prism.tokenize), and makes the page from that. */
window.Prism = { manual: true, disableWorkerMessageHandler: true };

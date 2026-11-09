const status = document.getElementById('status');
const openButton = document.getElementById('open-manager');

openButton.addEventListener('click', async () => {
  openButton.disabled = true;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab || !tab.id) throw new Error('No active tab');
    await chrome.tabs.sendMessage(tab.id, { type: 'vinted:openWardrobeManager' });
    window.close();
  } catch (error) {
    status.textContent = 'Open a supported Vinted wardrobe page first, then try again.';
    openButton.disabled = false;
  }
});

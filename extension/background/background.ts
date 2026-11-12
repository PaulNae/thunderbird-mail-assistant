// Placeholder background script. Listeners must be registered at top level (MV3).
messenger.runtime.onInstalled.addListener((details) => {
  console.log(`Mail Assistant installed (${details.reason})`);
});

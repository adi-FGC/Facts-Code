/**
 * Background service worker (MV3).
 *
 * Sole job for the MVP: make clicking the toolbar icon open the side panel.
 * `setPanelBehavior({ openPanelOnActionClick: true })` is the supported way to
 * bind the action button to the panel without a popup.
 *
 * Long analyses deliberately run in the PANEL page context (a dedicated module
 * Worker), NOT here — MV3 service workers are terminated after ~30s idle and
 * would corrupt an in-flight analyze.
 */
chrome?.runtime.onInstalled.addListener(() => {
  chrome?.sidePanel
    ?.setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {
      /* older Chrome without sidePanel.setPanelBehavior — the user can still
         open the panel from the extensions menu. */
    });
});

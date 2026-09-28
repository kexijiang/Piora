/** Compatibility helper for existing fixtures; connected devices need no app grants. */
export const authorizedManagerFactory = factory => factory;
export const fixtureQuality = { treeStatus: 'valid', scopeComplete: true, scope: 'window', appId: 'com.test.app', windowId: '1' };

/**
 * Grandchild process of the spawn chain: hangs until killed. Exists so tests
 * can verify that a whole process tree (child + grandchild) dies when the
 * fake CLI root is terminated (taskkill /T /F on Windows).
 */
setInterval(() => {}, 3_600_000);

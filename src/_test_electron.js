const electron = require('electron');
console.log('typeof electron:', typeof electron);
console.log('keys:', Object.keys(electron).sort().join(', '));
console.log('typeof app:', typeof electron.app);
if (electron.app) {
    electron.app.whenReady().then(() => {
        console.log('ELECTRON IS READY');
        electron.app.quit();
    });
} else {
    console.log('NO APP - electron module is broken');
    process.exit(1);
}

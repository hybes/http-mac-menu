const { app, Tray, Menu, BrowserWindow, nativeImage, Notification, globalShortcut, ipcMain, shell } = require('electron');

const BigNumber = require('bignumber.js');

const settings = require('electron-settings');
const path = require('path');
const axios = require('axios');
const Sentry = require('@sentry/electron');

const isDevelopment = process.env.NODE_ENV === 'development';

if (!isDevelopment) {
  Sentry.init({
    dsn: 'https://f7997ad0339b4241871f6f498c79c8bc@error.brth.uk/5',
  });
}

let tray = null;
let isQuiting = false;
let configWindow = null;
let prevNumber = null;

const HISTORY_LIMIT = 60; // Store up to 60 results
const DEFAULT_PERCENTAGE = 20; // Default percentage for comparison
const history = {}; // Object to store history of res2 results for each item

const getCurrentTimestamp = () => new Date().toISOString();

const compareResults = (currentValue, historyArray, percentThreshold, address) => {
  if (historyArray.length >= 2) {
    const scaledCurrentValue = new BigNumber(currentValue);
    const scaledMinValue = BigNumber.min(...historyArray.map(value => new BigNumber(value)));

    const change = scaledCurrentValue.minus(scaledMinValue).dividedBy(scaledMinValue).multipliedBy(100);

    // console.log(`${getCurrentTimestamp()} Change detected for ${address}: ${change.toFixed(2)}%`);

    const isSignificantChange = change.abs().isGreaterThan(percentThreshold);
    return isSignificantChange;
  }
  return false;
};

const notifyChange = (address, change, percentThreshold) => {
  let notification = new Notification({
    title: 'Price Change Alert',
    body: `The value of ${address} has changed by over ${percentThreshold}% in the last 15 minutes. Change: ${change.toFixed(2)}%`,
    silent: false
  });

  notification.show();
  notification.on('click', () => {
    shell.openExternal(`https://birdeye.so/token/${address}`);
  });
};

const fetchData = async (url, options) => {
  try {
    // Retrieve the API key from settings
    const apiKey = await settings.get('apiKey');
    if (!apiKey) {
      throw new Error('API key is not set in the settings.');
    }

    // Set the API key in the headers
    options.headers['X-API-KEY'] = apiKey;

    const response = await axios.get(url, options);
    return response.data;
  } catch (err) {
    console.error(`${getCurrentTimestamp()} `, err);
    Sentry.captureException(err);
    return null;
  }
};

const fetchRes = async () => {
  const options = {
    headers: {
      'accept': 'application/json',
      'x-chain': 'ethereum',
      'X-API-KEY': await settings.get('apiKey')
    }
  };

  const address = await settings.get('address');
  if (address) {
    // console.log(`${getCurrentTimestamp()} Fetching res data for address: ${address}`);
    const resData = await fetchData(`https://public-api.birdeye.so/v1/wallet/token_list?wallet=${address}`, options);
    if (resData) {
      const addresses = resData.data.items.map(item => item.address).join(',');
      const totalUsd = new BigNumber(resData.data.totalUsd).toFixed(2);
      if (tray && totalUsd) {
        tray.setTitle(`${totalUsd}`);
      }
      return addresses;
    }
  }
  return '';
};

const fetchRes2 = async (addresses) => {
  if (addresses) {
    const options2 = {
      headers: {
        'accept': 'application/json',
        'x-chain': 'solana',
        'X-API-KEY': await settings.get('apiKey')
      }
    };

    // console.log(`${getCurrentTimestamp()} Fetching res2 data for addresses: ${addresses}`);
    const res2Data = await fetchData(`https://public-api.birdeye.so/public/multi_price?list_address=${addresses}`, options2);
    if (res2Data) {
      const items = res2Data.data; // Assuming this is an array of items with their values

      for (const [address, item] of Object.entries(items)) {
        if (item) {
          const currentValue = item.value;
          const percentThreshold = new BigNumber(await settings.get('percent') || DEFAULT_PERCENTAGE);

          history[address] = history[address] || [];
          const itemHistory = history[address];
          itemHistory.push(currentValue);

          if (itemHistory.length > HISTORY_LIMIT) {
            itemHistory.shift();
          }

          // console.log(`${getCurrentTimestamp()} Current value for ${address}: ${currentValue}`);

          // Calculate change before using it in the comparison
          const change = new BigNumber(currentValue).minus(itemHistory[itemHistory.length - 2])
            .dividedBy(itemHistory[itemHistory.length - 2])
            .multipliedBy(100);

          if (!change.isZero() && compareResults(currentValue, itemHistory, percentThreshold, address)) {
            notifyChange(address, change, percentThreshold);
          }
        }
      }
    }
  }
};

const runTracking = async () => {
  const resFetchInterval = 15 * 60 * 1000; // 15 minutes
  const res2FetchInterval = 15 * 1000; // 15 seconds

  // Fetch res immediately and then on the set interval
  let addresses = await fetchRes();
  setInterval(async () => {
    addresses = await fetchRes();
  }, resFetchInterval);

  // Fetch res2 immediately and then on the set interval
  await fetchRes2(addresses);
  setInterval(() => {
    fetchRes2(addresses);
  }, res2FetchInterval);
};

const loadConfig = async () => settings.get();
const saveConfig = async (_, config) => {
  settings.set(config);
  configWindow.close();
};
const exitConfig = () => {
  if (configWindow) {
    configWindow.close();
  }
};
const openConfig = () => {
  if (!configWindow) {
    try {
      configWindow = new BrowserWindow({
        width: 840,
        height: 360,
        autoHideMenuBar: true,
        title: 'Configuration',
        webPreferences: {
          preload: path.join(__dirname, 'scripts/config.preload.js'),
          sandbox: false
        },
        icon: nativeImage.createFromPath('assets/trayWin.png')
      });

      configWindow.on('close', (event) => {
        if (!isQuiting) {
          event.preventDefault();
          configWindow.hide();
        }
        settings.get().then(config => {
          if (!isDevelopment) {
            // console.log(`${getCurrentTimestamp()} Current saved settings:`, config);
          }
        }).catch(err => {
          console.error(`${getCurrentTimestamp()} Error fetching settings:`, err);
        });
      });

      configWindow.loadFile('views/config.html');

      if (isDevelopment) {
        globalShortcut.register('CmdOrCtrl+D', () => {
          configWindow.webContents.openDevTools();
        });
      }
    } catch (err) {
      console.error(`${getCurrentTimestamp()} `, err);
      Sentry.captureException(err);
    }
  } else {
    configWindow.show();
  }
};
const exitApp = () => {
  app.quit();
};

app.whenReady().then(async () => {

  const apiKey = await settings.get('apiKey');

  if (!await settings.get() || !apiKey) {
    openConfig();
  }

  app.on('before-quit', () => {
    isQuiting = true;
  });

  ipcMain.handle('config:save', saveConfig);
  ipcMain.handle('config:load', loadConfig);
  ipcMain.handle('config:exit', exitConfig);

  ipcMain.on('open-external', (event, url) => {
    shell.openExternal(url);
  });

  app.setAppUserModelId('SOL Tracker');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Settings',
      type: 'normal',
      click: openConfig
    },
    {
      label: 'Quit',
      type: 'normal',
      click: exitApp
    }
  ]);

  let icon = null;
  let timer = await settings.get('timer') || 10000;

  if (process.platform === 'darwin') {
    icon = nativeImage.createEmpty();
    tray = new Tray(icon);
    app.dock.hide();
  } else {
    icon = nativeImage.createFromPath('assets/trayWin.png');
    tray = new Tray(icon);
  }

  tray.setContextMenu(contextMenu);
  tray.setToolTip('SOL Tracker');
  tray.setTitle('Invalid Config');

  runTracking();
});



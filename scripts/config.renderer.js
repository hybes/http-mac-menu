let saveConfig = document.getElementById('saveConfig')
let cancel = document.getElementById('cancel')

let config = null

const save = async () => {
    let inputs = document.forms['config'].getElementsByTagName('input')

    for (const input of inputs) {
        config[input.id] = input.value
    }

    await api.saveConfig(config)
    await api.exit()
}

const exit = async () => {
    await api.exit()
}

const loadConfig = async () => {
    config = await api.loadConfig()

    for (const setting in config) {
        let el = document.getElementById(setting)

        if (el)
            el.value = config[setting]
    }
}

document.getElementById('externalLink').addEventListener('click', (event) => {
    event.preventDefault(); // Prevent the default navigation
    window.api.openExternal('https://docs.birdeye.so/reference/intro/authentication');
  });

window.addEventListener('DOMContentLoaded', loadConfig)

saveConfig.onclick = async () => {
    await save()
}
// Adding a value starts from what you have in hand: an API address, a coin,
// or one of the examples. Each path hands the builder a seed and lets it
// fetch straight away, so the first thing shown is a real result.
(() => {
  const { h, icon, button, busy } = window.httpWidgets.dom;
  const { errorText, classifySource } = window.httpWidgetsUi;

  const QUICK_COINS = ['BTC', 'ETH', 'SOL'];

  const startOptions = (app) => {
    const start = (seed) => {
      app.setSeed(seed);
      app.go(app.routes.build());
    };

    // From an API -----------------------------------------------------------
    const sourceInput = h('textarea', {
      class: 'input start-source',
      id: 'startSource',
      rows: 2,
      placeholder: 'https://api.example.com/v1/status',
      autocapitalize: 'off',
      autocorrect: 'off',
      spellcheck: false,
      'aria-describedby': 'startSourceHint startSourceError',
    });
    const sourceError = h('span', {
      class: 'field-error',
      id: 'startSourceError',
      role: 'alert',
      hidden: true,
    });
    const sourceButton = button('Fetch it', { class: 'btn btn-primary' });

    const failSource = (message) => {
      sourceError.textContent = message;
      sourceError.hidden = false;
      sourceInput.setAttribute('aria-invalid', 'true');
      sourceInput.focus();
    };

    const submitSource = () =>
      busy(sourceButton, async () => {
        const source = classifySource(sourceInput.value);
        if (source.kind === 'empty' || source.kind === 'invalid') {
          failSource(
            'Enter an address such as https://api.example.com/v1/status, or paste a cURL command.'
          );
          return;
        }
        if (source.kind === 'url') {
          start({ values: { type: 'http', url: source.url }, fetch: true });
          return;
        }
        try {
          const parsed = await window.api.importCurl(source.text);
          if (!parsed.url) {
            failSource('That cURL command has no address in it.');
            return;
          }
          start({
            values: {
              type: 'http',
              url: parsed.url,
              headers: parsed.headers || '',
            },
            fetch: true,
            notes: parsed.warnings || [],
          });
        } catch (error) {
          failSource(errorText(error, 'That cURL command could not be read.'));
        }
      });

    sourceButton.addEventListener('click', submitSource);
    sourceInput.addEventListener('input', () => {
      sourceError.hidden = true;
      sourceInput.removeAttribute('aria-invalid');
    });
    sourceInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        submitSource();
      }
    });

    const fromApi = h(
      'section',
      { class: 'start-option', 'aria-labelledby': 'startApiHeading' },
      h('h2', { id: 'startApiHeading', text: 'From an API' }),
      h('p', {
        class: 'start-lede',
        id: 'startSourceHint',
        text: 'Paste an address or a cURL command. You pick the part of the response you want on the next screen.',
      }),
      h('div', { class: 'start-entry' }, sourceInput, sourceButton),
      sourceError
    );

    // A crypto price --------------------------------------------------------
    const coinInput = h('input', {
      class: 'input',
      id: 'startCoin',
      type: 'text',
      placeholder: 'Ticker, CoinGecko ID or Solana mint',
      autocapitalize: 'off',
      autocorrect: 'off',
      spellcheck: false,
      'aria-label': 'Another coin',
    });
    // Typed coins are passed on untouched: Solana mints are case-sensitive.
    const startCoin = (coin) => {
      const value = String(coin || '').trim();
      if (!value) {
        coinInput.focus();
        return;
      }
      start({
        values: { type: 'crypto', coin: value, provider: 'auto' },
        fetch: true,
      });
    };
    coinInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        startCoin(coinInput.value);
      }
    });

    const crypto = h(
      'section',
      { class: 'start-option', 'aria-labelledby': 'startCryptoHeading' },
      h('h2', { id: 'startCryptoHeading', text: 'A crypto price' }),
      h('p', {
        class: 'start-lede',
        text: 'A live price, or what your holdings are worth, with no API key.',
      }),
      h(
        'div',
        { class: 'start-coins' },
        QUICK_COINS.map((coin) =>
          h('button', {
            type: 'button',
            class: 'choice-chip',
            text: coin,
            on: { click: () => startCoin(coin.toLowerCase()) },
          })
        ),
        h(
          'div',
          { class: 'start-entry start-coin-entry' },
          coinInput,
          button('Use it', { on: { click: () => startCoin(coinInput.value) } })
        )
      )
    );

    // Examples --------------------------------------------------------------
    const presetList = h('ul', { class: 'row-list', role: 'list' });
    const presetStatus = h('p', {
      class: 'status',
      role: 'status',
      text: 'Loading examples…',
    });
    const examples = h(
      'section',
      { class: 'start-option', 'aria-labelledby': 'startExamplesHeading' },
      h('h2', { id: 'startExamplesHeading', text: 'Start from an example' }),
      h('p', {
        class: 'start-lede',
        text: 'Each one opens ready to save, and you can change anything first.',
      }),
      presetList,
      presetStatus
    );

    window.api
      .listPresets()
      .then((presets) => {
        const valid = Array.isArray(presets)
          ? presets.filter(
              (preset) =>
                preset && typeof preset.id === 'string' && preset.id.trim()
            )
          : [];
        presetStatus.textContent = valid.length
          ? ''
          : 'No examples are available right now.';
        presetStatus.hidden = valid.length > 0;
        presetList.replaceChildren(
          ...valid.map((preset) =>
            h(
              'li',
              null,
              h(
                'button',
                {
                  type: 'button',
                  class: 'row-button',
                  dataset: { presetId: preset.id },
                  on: {
                    click: () =>
                      start({
                        values: {
                          ...(preset.values || {}),
                          type: preset.kind === 'crypto' ? 'crypto' : 'http',
                        },
                        fetch: true,
                        from: preset.label,
                      }),
                  },
                },
                h(
                  'span',
                  { class: 'row-copy' },
                  h('span', { class: 'row-title', text: preset.label }),
                  h('span', {
                    class: 'row-detail',
                    text:
                      preset.description ||
                      (preset.kind === 'crypto'
                        ? 'Track a crypto value.'
                        : 'Track a value from an API.'),
                  })
                ),
                icon('forward', 'icon row-chevron')
              )
            )
          )
        );
      })
      .catch((error) => {
        presetStatus.hidden = false;
        presetStatus.dataset.state = 'error';
        presetStatus.textContent = errorText(
          error,
          'The examples could not be loaded. You can still add your own.'
        );
      });

    return h('div', { class: 'start-options' }, fromApi, crypto, examples);
  };

  const add = ({ root, app }) => {
    app.setBar({
      back: { label: 'Values', action: () => app.go(app.routes.home()) },
      title: 'Add a value',
    });

    const limit = h(
      'p',
      { class: 'notice', role: 'status', hidden: true },
      'You have as many values as the menu bar holds. Remove one to add another.'
    );
    const options = startOptions(app);
    root.append(limit, options);

    return {
      update: (store) => {
        const full = app.atLimit();
        limit.hidden = !full;
        options.inert = full;
        options.classList.toggle('is-disabled', full);
        if (full) {
          limit.textContent = `You have ${store.max} values, the most this app keeps. Remove one to add another.`;
        }
      },
    };
  };

  window.httpWidgets.views = window.httpWidgets.views || {};
  window.httpWidgets.views.add = add;
  window.httpWidgets.startOptions = startOptions;
})();

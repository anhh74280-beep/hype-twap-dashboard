const elements = {
  price: document.querySelector('#price'),
  twapSource: document.querySelector('#twapSource'),
  twapNet1h: document.querySelector('#twapNet1h'),
  twapNet24h: document.querySelector('#twapNet24h'),
  twapBuy24h: document.querySelector('#twapBuy24h'),
  twapSell24h: document.querySelector('#twapSell24h'),
  activeBuyCount: document.querySelector('#activeBuyCount'),
  activeSellCount: document.querySelector('#activeSellCount'),
  twapModeButtons: [...document.querySelectorAll('.twap-mode')]
};

let selectedTwapMode = 'spotPerp';

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0
});

const price = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4
});

function formatMoney(value, formatter = money) {
  return Number.isFinite(value) ? formatter.format(value) : '--';
}

function formatSigned(value) {
  if (!Number.isFinite(value)) {
    return '--';
  }

  return `${value > 0 ? '+' : ''}${money.format(value)}`;
}

function formatTime(value) {
  if (!value) {
    return '--';
  }

  return new Date(value).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

const lastValues = {
  price: null,
  twapNet1h: null,
  twapNet24h: null,
  twapBuy24h: null,
  twapSell24h: null
};

function triggerPulse(element, isUp) {
  element.classList.remove('pulse-up', 'pulse-down');
  void element.offsetWidth; // Force layout reflow to restart animation
  element.classList.add(isUp ? 'pulse-up' : 'pulse-down');
}

let isModeSwitching = false;

function animateValue(element, start, end, duration, formatFn, shouldPulse = false) {
  const currentVal = element._currentValue;
  const actualStart = (currentVal !== undefined && currentVal !== null) ? currentVal : (start !== null ? start : 0);

  if (!Number.isFinite(end)) {
    element.textContent = '--';
    element._currentValue = null;
    return;
  }

  const isUp = end > actualStart;
  const isDown = end < actualStart;
  if (shouldPulse) {
    if (isUp) triggerPulse(element, true);
    if (isDown) triggerPulse(element, false);
  }

  const startTime = performance.now();

  function update(currentTime) {
    const elapsed = currentTime - startTime;
    
    let currentValue;
    if (elapsed <= duration) {
      const progress = elapsed / duration;
      currentValue = actualStart + (end - actualStart) * progress;
    } else {
      // Smooth sinusoidal oscillation (drift) after reaching target value
      const driftElapsed = (elapsed - duration) / 1000; // in seconds
      const amplitude = Math.abs(end) * 0.00005; // 0.005% of value for a calm live vibration
      const oscillation = Math.sin(driftElapsed * 3.5) * amplitude;
      currentValue = end + oscillation;
    }

    element._currentValue = currentValue;
    element.textContent = formatFn(currentValue);

    element._animationId = requestAnimationFrame(update);
  }

  if (element._animationId) {
    cancelAnimationFrame(element._animationId);
  }
  element._animationId = requestAnimationFrame(update);
}

function animateSigned(element, start, end, duration, shouldPulse = false) {
  element.classList.toggle('positive', end > 0);
  element.classList.toggle('negative', end < 0);
  animateValue(element, start, end, duration, formatSigned, shouldPulse);
}

function animateMoney(element, start, end, duration, formatter = money, shouldPulse = false) {
  animateValue(element, start, end, duration, (val) => formatMoney(val, formatter), shouldPulse);
}



async function refresh() {
  const response = await fetch('/api/state');
  const state = await response.json();
  const latest = state.latest ?? {};
  const status = state.status ?? {};

  const visibleTwap = latest.twapModes?.[selectedTwapMode] ?? latest;

  elements.twapSource.textContent = status.twapSource ?? 'waiting';
  elements.activeBuyCount.textContent = visibleTwap.activeBuyCount ?? '--';
  elements.activeSellCount.textContent = visibleTwap.activeSellCount ?? '--';

  const shouldPulse = isModeSwitching;
  isModeSwitching = false; // Reset mode toggle flag

  const duration = 1200; // Animate over 1.2s to fully stretch across the 1.0s refresh intervals smoothly

  const targetPrice = latest.price;
  const targetNet1h = visibleTwap.twapNet1h;
  const targetNet24h = visibleTwap.twapNet24h;
  const targetBuy24h = visibleTwap.twapBuy24h;
  const targetSell24h = visibleTwap.twapSell24h;

  if (lastValues.price !== targetPrice) {
    animateMoney(elements.price, lastValues.price, targetPrice, duration, price, shouldPulse);
    lastValues.price = targetPrice;
  }
  if (lastValues.twapNet1h !== targetNet1h) {
    animateSigned(elements.twapNet1h, lastValues.twapNet1h, targetNet1h, duration, shouldPulse);
    lastValues.twapNet1h = targetNet1h;
  }
  if (lastValues.twapNet24h !== targetNet24h) {
    animateSigned(elements.twapNet24h, lastValues.twapNet24h, targetNet24h, duration, shouldPulse);
    lastValues.twapNet24h = targetNet24h;
  }
  if (lastValues.twapBuy24h !== targetBuy24h) {
    animateMoney(elements.twapBuy24h, lastValues.twapBuy24h, targetBuy24h, duration, money, shouldPulse);
    lastValues.twapBuy24h = targetBuy24h;
  }
  if (lastValues.twapSell24h !== targetSell24h) {
    animateMoney(elements.twapSell24h, lastValues.twapSell24h, targetSell24h, duration, money, shouldPulse);
    lastValues.twapSell24h = targetSell24h;
  }


}



for (const button of elements.twapModeButtons) {
  button.addEventListener('click', () => {
    selectedTwapMode = button.dataset.twapMode;
    elements.twapModeButtons.forEach((item) => item.classList.toggle('active', item === button));
    isModeSwitching = true;
    refresh().catch(console.error);
  });
}

// Translations and Language Switch Logic
const TRANSLATIONS = {
  en: {
    eyebrow: "Hyperliquid HYPE",
    title: "TWAP Monitor",
    openChart: "Open chart",
    hypePrice: "HYPE price",
    twapSource: "TWAP source",
    twapMode: "TWAP mode",
    spotPerp: "Spot + Perp",
    spot: "Spot",
    perp: "Perp",
    next1hNet: "Next 1H net",
    buyMinusSell: "buy minus sell",
    next24hNet: "Next 24H net",
    buy24h: "24H buy",
    activeBuyTwaps: "active buy TWAPs",
    sell24h: "24H sell",
    activeSellTwaps: "active sell TWAPs"
  },
  ru: {
    eyebrow: "Hyperliquid HYPE",
    title: "TWAP Монитор",
    openChart: "Открыть график",
    hypePrice: "Цена HYPE",
    twapSource: "Источник TWAP",
    twapMode: "Режим TWAP",
    spotPerp: "Спот + Перп",
    spot: "Спот",
    perp: "Перп",
    next1hNet: "Чистый 1Ч",
    buyMinusSell: "покупки минус продажи",
    next24hNet: "Чистый 24Ч",
    buy24h: "Покупки 24Ч",
    activeBuyTwaps: "активных TWAP покупок",
    sell24h: "Продажи 24Ч",
    activeSellTwaps: "активных TWAP продаж"
  }
};

function applyLanguage(lang) {
  localStorage.setItem('hype_twap_lang', lang);
  
  const enBtn = document.getElementById('langBtnEn');
  const ruBtn = document.getElementById('langBtnRu');
  if (enBtn) enBtn.classList.toggle('active', lang === 'en');
  if (ruBtn) ruBtn.classList.toggle('active', lang === 'ru');

  const t = TRANSLATIONS[lang] || TRANSLATIONS.en;

  const txtEyebrow = document.getElementById('txtEyebrow');
  if (txtEyebrow) txtEyebrow.textContent = t.eyebrow;
  const txtTitle = document.getElementById('txtTitle');
  if (txtTitle) txtTitle.textContent = t.title;
  const lnkOpenChart = document.getElementById('lnkOpenChart');
  if (lnkOpenChart) lnkOpenChart.textContent = t.openChart;

  const lblHypePrice = document.getElementById('lblHypePrice');
  if (lblHypePrice) lblHypePrice.textContent = t.hypePrice;
  const lblTwapSource = document.getElementById('lblTwapSource');
  if (lblTwapSource) lblTwapSource.textContent = t.twapSource;
  const lblTwapMode = document.getElementById('lblTwapMode');
  if (lblTwapMode) lblTwapMode.textContent = t.twapMode;

  const spotPerpBtn = document.querySelector('[data-twap-mode="spotPerp"]');
  if (spotPerpBtn) spotPerpBtn.textContent = t.spotPerp;
  const spotBtn = document.querySelector('[data-twap-mode="spot"]');
  if (spotBtn) spotBtn.textContent = t.spot;
  const perpBtn = document.querySelector('[data-twap-mode="perp"]');
  if (perpBtn) perpBtn.textContent = t.perp;

  const lblNet1h = document.getElementById('lblNet1h');
  if (lblNet1h) lblNet1h.textContent = t.next1hNet;
  const lblNet24h = document.getElementById('lblNet24h');
  if (lblNet24h) lblNet24h.textContent = t.next24hNet;
  const lblBuy24h = document.getElementById('lblBuy24h');
  if (lblBuy24h) lblBuy24h.textContent = t.buy24h;
  const lblSell24h = document.getElementById('lblSell24h');
  if (lblSell24h) lblSell24h.textContent = t.sell24h;

  const lblBuyMinusSell1 = document.getElementById('lblBuyMinusSell1');
  if (lblBuyMinusSell1) lblBuyMinusSell1.textContent = t.buyMinusSell;
  const lblBuyMinusSell2 = document.getElementById('lblBuyMinusSell2');
  if (lblBuyMinusSell2) lblBuyMinusSell2.textContent = t.buyMinusSell;

  const lblActiveBuys = document.getElementById('lblActiveBuys');
  if (lblActiveBuys) lblActiveBuys.textContent = t.activeBuyTwaps;
  const lblActiveSells = document.getElementById('lblActiveSells');
  if (lblActiveSells) lblActiveSells.textContent = t.activeSellTwaps;
}

const currentLang = localStorage.getItem('hype_twap_lang') || 'en';
document.getElementById('langBtnEn').addEventListener('click', () => applyLanguage('en'));
document.getElementById('langBtnRu').addEventListener('click', () => applyLanguage('ru'));

applyLanguage(currentLang);

refresh().catch(console.error);
setInterval(() => refresh().catch(console.error), 5000);


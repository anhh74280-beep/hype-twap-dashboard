// Active charts and series references
let priceChart = null;
let priceSeries = null;
let twapChart = null;
let twapSeriesMap = {};

let activeCharts = []; // Price, TWAP, and dynamic subcharts
let dynamicPanels = []; // list of: { panelId, chart, activeMetrics }
let panelCount = 0; // panel numbering index

let currentBuckets = [];
let selectedTimeframe = '1m';
let selectedTwapMode = 'spotPerp';

function getLocalTimestamp(timestampStr) {
  const d = new Date(timestampStr);
  const localTimeMs = d.getTime() - (d.getTimezoneOffset() * 60 * 1000);
  return Math.floor(localTimeMs / 1000);
}

// UI Selectors
const snapshotCount = document.querySelector('#snapshotCount');
const priceRange = document.querySelector('#priceRange');
const timeframeButtons = [...document.querySelectorAll('.timeframe')];
const twapModeButtons = [...document.querySelectorAll('.twap-mode')];
const metricInputs = [...document.querySelectorAll('[data-metric]')];
const addNewPanelBtn = document.querySelector('#addNewPanelBtn');
const exchangeSourceSelect = document.querySelector('#exchangeSourceSelect');
const chartsStack = document.querySelector('#chartsStack');

// Chart Theme styling
const chartTheme = {
  layout: {
    background: { type: 'solid', color: '#11161a' },
    textColor: '#81908b',
    fontSize: 11,
    fontFamily: 'Segoe UI, sans-serif'
  },
  grid: {
    vertLines: { color: 'rgba(38, 49, 55, 0.4)' },
    horzLines: { color: 'rgba(38, 49, 55, 0.4)' }
  },
  crosshair: {
    mode: 0 // Normal
  },
  rightPriceScale: {
    borderColor: '#263137',
    alignLabels: true
  },
  timeScale: {
    borderColor: '#263137',
    timeVisible: true,
    secondsVisible: false
  }
};

// Compact number formatting (e.g. 100500 -> $100.5k, 5400000 -> $5.4M)
function formatKandM(val) {
  if (val === null || val === undefined || !Number.isFinite(val)) return '';
  const absVal = Math.abs(val);
  const sign = val < 0 ? '-' : '';
  if (absVal >= 1_000_000) {
    return sign + '$' + (absVal / 1_000_000).toFixed(1) + 'M';
  }
  if (absVal >= 1_000) {
    return sign + '$' + (absVal / 1_000).toFixed(1) + 'k';
  }
  return sign + '$' + absVal.toFixed(2);
}

function formatRatio(val) {
  if (val === null || val === undefined || !Number.isFinite(val)) return '';
  return val.toFixed(2);
}

function formatPrice(value) {
  return Number.isFinite(value) ? `$${value.toFixed(4)}` : '--';
}

// Automatic Resizing Observer
const resizeObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const container = entry.target;
    const chart = activeCharts.find(c => c._container === container);
    if (chart && entry.contentRect.height > 10) {
      chart.resize(entry.contentRect.width, entry.contentRect.height);

      // Update ruler canvas size if exists
      const canvas = container.querySelector('.ruler-canvas');
      if (canvas) {
        canvas.width = entry.contentRect.width;
        canvas.height = entry.contentRect.height;
        if (canvas.drawRuler) {
          canvas.drawRuler();
        }
      }
    }
  }
});

// Timescale Synchronization Logic (Registered once per chart instance on init)
let isTimescaleSyncing = false;
function handleTimescaleChange(srcChart, range) {
  if (isTimescaleSyncing || !range) return;
  isTimescaleSyncing = true;
  activeCharts.forEach((targetChart) => {
    if (targetChart !== srcChart) {
      targetChart.timeScale().setVisibleLogicalRange(range);
    }
  });
  isTimescaleSyncing = false;
}

// Crosshair Synchronization Logic (Registered once per chart instance on init)
let isCrosshairSyncing = false;
function handleCrosshairMove(srcChart, param) {
  if (isCrosshairSyncing) return;
  isCrosshairSyncing = true;

  const time = param.time;
  activeCharts.forEach((targetChart) => {
    if (targetChart !== srcChart) {
      if (time === undefined || param.logical === undefined) {
        targetChart.clearCrosshairPosition();
      } else {
        const targetSeries = targetChart._syncSeries;
        if (targetSeries) {
          const bucket = currentBuckets.find(
            (b) => getLocalTimestamp(b.timestamp) === time
          );

          let targetPrice = 0;
          if (bucket) {
            if (targetChart._type === 'price') {
              targetPrice = bucket.close ?? bucket.price ?? 0;
            } else if (targetChart._type === 'twap') {
              const mode = selectedTwapMode;
              targetPrice = bucket.twapModes?.[mode]?.twapNet1h ?? bucket.twapNet1h ?? 0;
            } else if (targetChart._type === 'dynamic') {
              const panelId = targetChart._panelId;
              const panel = dynamicPanels.find(p => p.panelId === panelId);
              if (panel) {
                // Find first active metric key to snap to
                const firstKey = Object.keys(panel.activeMetrics)[0];
                if (firstKey) {
                  const metric = panel.activeMetrics[firstKey];
                  const type = metric.type;
                  const suffix = metric.depth.replace('.', '_');
                  const source = exchangeSourceSelect.value;
                  
                  if (type === 'bid' || type === 'ask') {
                    if (source === 'combined') {
                      targetPrice = ((bucket[`bybit_${type}_${suffix}`] || 0) + (bucket[`hl_${type}_${suffix}`] || 0)) || 0;
                    } else if (source === 'hl') {
                      targetPrice = bucket[`hl_${type}_${suffix}`] ?? 0;
                    } else {
                      targetPrice = bucket[`bybit_${type}_${suffix}`] ?? 0;
                    }
                  } else if (type === 'diff') {
                    const isCustomDiff = [
                      '3B_8A', '8B_3A', '8A_3B', '8B_30A', '5B_15A',
                      '15B_5A', '8B_15A', '15B_8A', '15B_30A', '30B_15A',
                      '30_15', '30_8', '15_8', '8_5'
                    ].includes(depth);
                    if (isCustomDiff) {
                      targetPrice = bucket[`diff_${depth}`] ?? 0;
                    } else {
                      let bidVal = 0;
                      let askVal = 0;
                      if (source === 'bybit') {
                        bidVal = bucket[`bybit_bid_${suffix}`] || 0;
                        askVal = bucket[`bybit_ask_${suffix}`] || 0;
                      } else if (source === 'hl') {
                        bidVal = bucket[`hl_bid_${suffix}`] || 0;
                        askVal = bucket[`hl_ask_${suffix}`] || 0;
                      } else {
                        bidVal = (bucket[`bybit_bid_${suffix}`] || 0) + (bucket[`hl_bid_${suffix}`] || 0);
                        askVal = (bucket[`bybit_ask_${suffix}`] || 0) + (bucket[`hl_ask_${suffix}`] || 0);
                      }
                      targetPrice = bidVal - askVal;
                    }
                  } else if (type === 'avg') {
                    let bidVal = 0;
                    let askVal = 0;
                    if (source === 'bybit') {
                      bidVal = bucket[`bybit_bid_${suffix}`] || 0;
                      askVal = bucket[`bybit_ask_${suffix}`] || 0;
                    } else if (source === 'hl') {
                      bidVal = bucket[`hl_bid_${suffix}`] || 0;
                      askVal = bucket[`hl_ask_${suffix}`] || 0;
                    } else {
                      bidVal = (bucket[`bybit_bid_${suffix}`] || 0) + (bucket[`hl_bid_${suffix}`] || 0);
                      askVal = (bucket[`bybit_ask_${suffix}`] || 0) + (bucket[`hl_ask_${suffix}`] || 0);
                    }
                    targetPrice = askVal > 0 ? (bidVal / askVal) : (bidVal === 0 ? 1.0 : 0.0);
                  }
                }
              }
            }
          }
          targetChart.setCrosshairPosition(targetPrice, time, targetSeries);
        }
      }
    }
  });

  isCrosshairSyncing = false;
}

// 1. Initializing Price Chart
function initPriceChart() {
  const container = document.querySelector('#priceChart');
  const rect = container.getBoundingClientRect();
  
  priceChart = LightweightCharts.createChart(container, {
    ...chartTheme,
    width: rect.width,
    height: rect.height || 300,
    localization: {
      priceFormatter: formatPrice
    }
  });

  priceSeries = priceChart.addCandlestickSeries({
    upColor: '#35d083',
    downColor: '#ef5e5e',
    borderVisible: false,
    wickUpColor: '#35d083',
    wickDownColor: '#ef5e5e',
    priceLineVisible: false
  });

  priceChart._type = 'price';
  priceChart._container = container;
  priceChart._syncSeries = priceSeries;

  activeCharts.push(priceChart);
  resizeObserver.observe(container);

  // Register Event Listeners once
  priceChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    handleTimescaleChange(priceChart, range);
  });
  priceChart.subscribeCrosshairMove((param) => {
    handleCrosshairMove(priceChart, param);
  });
}

// 2. Initializing TWAP Chart
function initTwapChart() {
  const container = document.querySelector('#twapChart');
  const rect = container.getBoundingClientRect();

  twapChart = LightweightCharts.createChart(container, {
    ...chartTheme,
    width: rect.width,
    height: rect.height || 240,
    localization: {
      priceFormatter: formatKandM
    }
  });

  twapSeriesMap = {
    twapNet1h: twapChart.addLineSeries({ color: '#5aa7ff', lineWidth: 2, title: 'Net 1H', priceLineVisible: false }),
    twapNet24h: twapChart.addLineSeries({ color: '#eef4ee', lineWidth: 1.5, title: 'Net 24H', priceLineVisible: false }),
    twapBuy24h: twapChart.addLineSeries({ color: '#35d083', lineWidth: 1.5, title: 'Buy 24H', priceLineVisible: false }),
    twapSell24h: twapChart.addLineSeries({ color: '#ef5e5e', lineWidth: 1.5, title: 'Sell 24H', priceLineVisible: false })
  };

  twapChart._type = 'twap';
  twapChart._container = container;
  twapChart._syncSeries = twapSeriesMap.twapNet1h;

  activeCharts.push(twapChart);
  resizeObserver.observe(container);
  updateTwapSeriesVisibility();

  // Register Event Listeners once
  twapChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    handleTimescaleChange(twapChart, range);
  });
  twapChart.subscribeCrosshairMove((param) => {
    handleCrosshairMove(twapChart, param);
  });
}

// Update TWAP Series visibility based on checklist
function updateTwapSeriesVisibility() {
  metricInputs.forEach((input) => {
    const key = input.dataset.metric;
    const series = twapSeriesMap[key];
    if (series) {
      series.applyOptions({
        visible: input.checked
      });
    }
  });
}

// Custom colors mapping based on type and depth percentages
function getMetricColor(type, depth) {
  const customColors = {
    '3B_8A': '#00c6ff',
    '8B_3A': '#0072ff',
    '8A_3B': '#5f27cd',
    '8B_30A': '#ff9f43',
    '5B_15A': '#f5d020',
    '15B_5A': '#35d083',
    '8B_15A': '#ee5253',
    '15B_8A': '#ff4e50',
    '15B_30A': '#2af598',
    '30B_15A': '#95afc0',
    '30_15': '#e056fd',
    '30_8': '#ff7979',
    '15_8': '#badc58',
    '8_5': '#ffbe76'
  };
  if (customColors[depth]) {
    return customColors[depth];
  }
  const colors = {
    '1.5': { bid: '#2af598', ask: '#ff4e50', diff: '#5aa7ff', avg: '#c56cf0' },
    '3':   { bid: '#35d083', ask: '#ef5e5e', diff: '#00c6ff', avg: '#ff9f1c' },
    '5':   { bid: '#7efeb4', ask: '#ff9595', diff: '#0072ff', avg: '#ff5252' },
    '8':   { bid: '#10ac84', ask: '#ee5253', diff: '#5f27cd', avg: '#33d9b2' },
    '15':  { bid: '#05c46b', ask: '#ff3f34', diff: '#ff9f43', avg: '#34ace0' },
    '30':  { bid: '#00d2d3', ask: '#ff6b6b', diff: '#f5d020', avg: '#ff7979' },
    '60':  { bid: '#1dd1a1', ask: '#ff6b81', diff: '#95afc0', avg: '#70a1ff' }
  };
  return colors[depth]?.[type] ?? '#ffffff';
}

// Update dynamic subchart metric series visibility based on exchange source selection
function updatePanelMetricVisibility(panel, metricKey) {
  const source = exchangeSourceSelect.value;
  const metric = panel.activeMetrics[metricKey];
  if (!metric) return;

  if (metric.type === 'bid' || metric.type === 'ask') {
    const s = metric.series;
    s.bybit.applyOptions({ visible: (source === 'bybit' || source === 'all') });
    s.hl.applyOptions({ visible: (source === 'hl' || source === 'all') });
    s.combined.applyOptions({ visible: (source === 'combined') });
  } else if (metric.type === 'diff') {
    metric.series.diff.applyOptions({ visible: true });
  } else if (metric.type === 'avg') {
    metric.series.avg.applyOptions({ visible: true });
  }
}

// Update all dynamic subcharts when global configurations change
function updateAllSubcharts() {
  dynamicPanels.forEach((panel) => {
    Object.keys(panel.activeMetrics).forEach((metricKey) => {
      updatePanelMetricVisibility(panel, metricKey);
      if (panel.activeMetrics[metricKey].type === 'diff') {
        populatePanelDiffData(panel, metricKey);
      } else if (panel.activeMetrics[metricKey].type === 'avg') {
        populatePanelAvgData(panel, metricKey);
      }
    });
  });
}

// Create a new empty dynamic subchart panel
function createNewPanel() {
  panelCount++;
  const panelId = `panel_${Date.now()}`;

  const wrapperDiv = document.createElement('div');
  wrapperDiv.className = 'chart-wrapper-container dynamic-panel-container';
  wrapperDiv.setAttribute('data-panel-id', panelId);

  wrapperDiv.innerHTML = `
    <div class="panel-header-controls">
      <span class="panel-label">Subchart #${panelCount}</span>
      <div class="panel-actions-group">
        <select class="add-metric-select" data-panel-id="${panelId}">
          <option value="" disabled selected>+ Add Metric...</option>
          <optgroup label="Bid Depth">
            <option value="bid_1.5">Bid Depth 1.5%</option>
            <option value="bid_3">Bid Depth 3%</option>
            <option value="bid_5">Bid Depth 5%</option>
            <option value="bid_8">Bid Depth 8%</option>
            <option value="bid_15">Bid Depth 15%</option>
            <option value="bid_30">Bid Depth 30%</option>
            <option value="bid_60">Bid Depth 60%</option>
          </optgroup>
          <optgroup label="Ask Depth">
            <option value="ask_1.5">Ask Depth 1.5%</option>
            <option value="ask_3">Ask Depth 3%</option>
            <option value="ask_5">Ask Depth 5%</option>
            <option value="ask_8">Ask Depth 8%</option>
            <option value="ask_15">Ask Depth 15%</option>
            <option value="ask_30">Ask Depth 30%</option>
            <option value="ask_60">Ask Depth 60%</option>
          </optgroup>
          <optgroup label="Difference (Bid - Ask)">
            <option value="diff_1.5">Diff Depth 1.5%</option>
            <option value="diff_3">Diff Depth 3%</option>
            <option value="diff_5">Diff Depth 5%</option>
            <option value="diff_8">Diff Depth 8%</option>
            <option value="diff_15">Diff Depth 15%</option>
            <option value="diff_30">Diff Depth 30%</option>
            <option value="diff_60">Diff Depth 60%</option>
          </optgroup>
          <optgroup label="Difference (Custom)">
            <option value="diff_3B_8A">Diff 3B-8A</option>
            <option value="diff_8B_3A">Diff 8B-3A</option>
            <option value="diff_8A_3B">Diff 8A-3B</option>
            <option value="diff_8B_30A">Diff 8B-30A</option>
            <option value="diff_5B_15A">Diff 5B-15A</option>
            <option value="diff_15B_5A">Diff 15B-5A</option>
            <option value="diff_8B_15A">Diff 8B-15A</option>
            <option value="diff_15B_8A">Diff 15B-8A</option>
            <option value="diff_15B_30A">Diff 15B-30A</option>
            <option value="diff_30B_15A">Diff 30B-15A</option>
            <option value="diff_30_15">Diff 30-15</option>
            <option value="diff_30_8">Diff 30-8</option>
            <option value="diff_15_8">Diff 15-8</option>
          </optgroup>
          <optgroup label="Average Ratio (Bid / Ask)">
            <option value="avg_1.5">Avg Depth 1.5%</option>
            <option value="avg_3">Avg Depth 3%</option>
            <option value="avg_5">Avg Depth 5%</option>
            <option value="avg_8">Avg Depth 8%</option>
            <option value="avg_15">Avg Depth 15%</option>
            <option value="avg_30">Avg Depth 30%</option>
            <option value="avg_60">Avg Depth 60%</option>
          </optgroup>
        </select>
        <button class="close-panel-btn" data-panel-id="${panelId}" type="button">×</button>
      </div>
    </div>
    <div class="active-metrics-badges" id="badges_${panelId}"></div>
    <div id="chart_${panelId}" class="lightweight-chart-wrapper subchart-wrapper"></div>
  `;

  chartsStack.appendChild(wrapperDiv);

  const container = document.getElementById(`chart_${panelId}`);
  const rect = container.getBoundingClientRect();

  const chart = LightweightCharts.createChart(container, {
    ...chartTheme,
    width: rect.width || 300,
    height: rect.height || 160,
    localization: {
      priceFormatter: formatKandM
    }
  });

  chart._type = 'dynamic';
  chart._panelId = panelId;
  chart._container = container;

  const panelObj = {
    panelId,
    chart,
    activeMetrics: {}
  };

  dynamicPanels.push(panelObj);
  activeCharts.push(chart);
  resizeObserver.observe(container);

  // Synchronization event listeners
  chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    handleTimescaleChange(chart, range);
  });
  chart.subscribeCrosshairMove((param) => {
    handleCrosshairMove(chart, param);
  });

  // Setup Event Listeners
  wrapperDiv.querySelector('.close-panel-btn').addEventListener('click', () => {
    removePanel(panelId);
  });

  wrapperDiv.querySelector('.add-metric-select').addEventListener('change', (e) => {
    const val = e.target.value;
    if (!val) return;
    const firstUnderscore = val.indexOf('_');
    const type = val.slice(0, firstUnderscore);
    const depth = val.slice(firstUnderscore + 1);
    addMetricToPanel(panelId, type, depth);
    e.target.value = ''; // reset dropdown select
  });

  // Sync to current timescale range
  const currentRange = priceChart.timeScale().getVisibleLogicalRange();
  if (currentRange) {
    chart.timeScale().setVisibleLogicalRange(currentRange);
  }

  if (isRulerModeActive) {
    updateRulerOverlays();
  }
}

// Add a specific metric onto a dynamic subchart panel
function addMetricToPanel(panelId, type, depth, customColor = null) {
  const panel = dynamicPanels.find(p => p.panelId === panelId);
  if (!panel) return;

  const metricKey = `${type}_${depth}`;
  if (panel.activeMetrics[metricKey]) return; // already added

  const color = customColor || getMetricColor(type, depth);
  const series = {};

  if (type === 'bid' || type === 'ask') {
    series.bybit = panel.chart.addLineSeries({
      color: color,
      lineWidth: 1.5,
      title: `Bybit ${type === 'bid' ? 'Bid' : 'Ask'} ${depth}%`,
      priceLineVisible: false
    });
    series.hl = panel.chart.addLineSeries({
      color: color,
      lineWidth: 1.2,
      lineStyle: 2,
      title: `HL ${type === 'bid' ? 'Bid' : 'Ask'} ${depth}%`,
      priceLineVisible: false
    });
    series.combined = panel.chart.addLineSeries({
      color: color,
      lineWidth: 2.2,
      title: `Combined ${type === 'bid' ? 'Bid' : 'Ask'} ${depth}%`,
      priceLineVisible: false
    });
  } else if (type === 'diff') {
    const title = depth.includes('B') || depth.includes('_') ? `DIFF ${depth.replace('_', '-')}` : `Diff ${depth}%`;
    
    // Check if customColor was provided (meaning color is overridden)
    const topCol = customColor || '#35d083';
    const botCol = customColor || '#ef5e5e';
    
    series.diff = panel.chart.addBaselineSeries({
      baseValue: { type: 'price', price: 0 },
      topLineColor: topCol,
      topFillColor1: 'rgba(53, 208, 131, 0.15)',
      topFillColor2: 'rgba(53, 208, 131, 0.0)',
      bottomLineColor: botCol,
      bottomFillColor1: 'rgba(239, 94, 94, 0.0)',
      bottomFillColor2: 'rgba(239, 94, 94, 0.15)',
      lineWidth: 2,
      title: title,
      priceLineVisible: false
    });
  } else if (type === 'avg') {
    const title = `Avg ${depth}%`;
    series.avg = panel.chart.addBaselineSeries({
      baseValue: { type: 'price', price: 1.0 },
      topLineColor: color,          // Uniform line color
      topFillColor1: 'rgba(53, 208, 131, 0.15)',
      topFillColor2: 'rgba(53, 208, 131, 0.0)',
      bottomLineColor: color,       // Uniform line color (no red line!)
      bottomFillColor1: 'rgba(239, 94, 94, 0.0)',
      bottomFillColor2: 'rgba(239, 94, 94, 0.15)',
      lineWidth: 2,
      title: title,
      priceLineVisible: false
    });
  }

  panel.activeMetrics[metricKey] = {
    type,
    depth,
    color,
    series
  };

  // Set appropriate Y-axis formatter based on active metrics (ratio vs absolute numbers)
  const hasAvg = Object.values(panel.activeMetrics).some(m => m.type === 'avg');
  panel.chart.applyOptions({
    localization: {
      priceFormatter: hasAvg ? formatRatio : formatKandM
    }
  });

  // Sync crosshair snap series reference to the first metric added
  const firstKey = Object.keys(panel.activeMetrics)[0];
  if (firstKey) {
    const firstMetric = panel.activeMetrics[firstKey];
    panel.chart._syncSeries = firstMetric.type === 'diff' 
      ? firstMetric.series.diff 
      : (firstMetric.type === 'avg' ? firstMetric.series.avg : firstMetric.series.combined);
  }

  updatePanelBadges(panelId);
  updatePanelMetricVisibility(panel, metricKey);

  if (type === 'diff') {
    populatePanelDiffData(panel, metricKey);
  } else if (type === 'avg') {
    populatePanelAvgData(panel, metricKey);
  } else {
    populatePanelDepthData(panel, metricKey);
  }
}

// Remove a specific metric from a dynamic subchart panel
function removeMetricFromPanel(panelId, metricKey) {
  const panel = dynamicPanels.find(p => p.panelId === panelId);
  if (!panel) return;

  const metric = panel.activeMetrics[metricKey];
  if (!metric) return;

  Object.values(metric.series).forEach((seriesInstance) => {
    panel.chart.removeSeries(seriesInstance);
  });

  delete panel.activeMetrics[metricKey];

  // Set appropriate Y-axis formatter based on remaining active metrics
  const hasAvg = Object.values(panel.activeMetrics).some(m => m.type === 'avg');
  panel.chart.applyOptions({
    localization: {
      priceFormatter: hasAvg ? formatRatio : formatKandM
    }
  });

  // Update crosshair snap reference
  const firstKey = Object.keys(panel.activeMetrics)[0];
  if (firstKey) {
    const firstMetric = panel.activeMetrics[firstKey];
    panel.chart._syncSeries = firstMetric.type === 'diff' 
      ? firstMetric.series.diff 
      : (firstMetric.type === 'avg' ? firstMetric.series.avg : firstMetric.series.combined);
  } else {
    panel.chart._syncSeries = null;
  }

  updatePanelBadges(panelId);
}

// Render active metric badges inside panel header
function updatePanelBadges(panelId) {
  const panel = dynamicPanels.find(p => p.panelId === panelId);
  if (!panel) return;

  const badgesDiv = document.getElementById(`badges_${panelId}`);
  if (!badgesDiv) return;

  badgesDiv.innerHTML = '';

  Object.keys(panel.activeMetrics).forEach((metricKey) => {
    const metric = panel.activeMetrics[metricKey];
    let label;
    if (metric.type === 'diff' && (metric.depth.includes('B') || metric.depth.includes('_'))) {
      label = `DIFF ${metric.depth.replace('_', '-')}`;
    } else {
      label = `${metric.type.toUpperCase()} ${metric.depth}%`;
    }

    const badge = document.createElement('div');
    badge.className = 'metric-badge';
    badge.innerHTML = `
      <span class="badge-color-dot" style="background-color: ${metric.color}; cursor: pointer;" title="Change Color"></span>
      <input type="color" class="badge-color-picker" value="${metric.color}" style="display: none;">
      <span>${label}</span>
      <button class="remove-badge-btn" type="button" data-metric-key="${metricKey}">×</button>
    `;

    const colorDot = badge.querySelector('.badge-color-dot');
    const colorPicker = badge.querySelector('.badge-color-picker');

    colorDot.addEventListener('click', () => {
      colorPicker.click();
    });

    colorPicker.addEventListener('change', (e) => {
      const newColor = e.target.value;
      colorDot.style.backgroundColor = newColor;
      updateMetricColor(panelId, metricKey, newColor);
    });

    badge.querySelector('.remove-badge-btn').addEventListener('click', () => {
      removeMetricFromPanel(panelId, metricKey);
    });

    badgesDiv.appendChild(badge);
  });
}

function updateMetricColor(panelId, metricKey, newColor) {
  const panel = dynamicPanels.find(p => p.panelId === panelId);
  if (!panel) return;

  const metric = panel.activeMetrics[metricKey];
  if (!metric) return;

  metric.color = newColor;

  if (metric.type === 'bid' || metric.type === 'ask') {
    if (metric.series.bybit) metric.series.bybit.applyOptions({ color: newColor });
    if (metric.series.hl) metric.series.hl.applyOptions({ color: newColor });
    if (metric.series.combined) metric.series.combined.applyOptions({ color: newColor });
  } else if (metric.type === 'diff') {
    if (metric.series.diff) {
      metric.series.diff.applyOptions({
        topLineColor: newColor,
        bottomLineColor: newColor
      });
    }
  } else if (metric.type === 'avg') {
    if (metric.series.avg) {
      metric.series.avg.applyOptions({
        topLineColor: newColor,
        bottomLineColor: newColor
      });
    }
  }
}

// Remove dynamic panel instance
function removePanel(panelId) {
  const panelIndex = dynamicPanels.findIndex(p => p.panelId === panelId);
  if (panelIndex === -1) return;

  const panel = dynamicPanels[panelIndex];

  if (panel._container) {
    resizeObserver.unobserve(panel._container);
  }

  activeCharts = activeCharts.filter((c) => c !== panel.chart);
  dynamicPanels.splice(panelIndex, 1);

  const wrapper = chartsStack.querySelector(`[data-panel-id="${panelId}"]`);
  if (wrapper) {
    wrapper.remove();
  }

  // Re-sync logical range for remaining charts
  const range = priceChart.timeScale().getVisibleLogicalRange();
  if (range) {
    activeCharts.forEach((targetChart) => {
      targetChart.timeScale().setVisibleLogicalRange(range);
    });
  }
}

// Populate Data
function populatePriceData() {
  const candles = currentBuckets.map((bucket) => ({
    time: getLocalTimestamp(bucket.timestamp),
    open: bucket.open ?? bucket.price,
    high: bucket.high ?? bucket.price,
    low: bucket.low ?? bucket.price,
    close: bucket.close ?? bucket.price
  })).filter((c) => Number.isFinite(c.open));

  priceSeries.setData(candles);

  if (candles.length > 0) {
    const minPrice = Math.min(...candles.map(c => c.low));
    const maxPrice = Math.max(...candles.map(c => c.high));
    priceRange.textContent = `${formatPrice(minPrice)} - ${formatPrice(maxPrice)}`;
  } else {
    priceRange.textContent = '--';
  }
}

function populateTwapData() {
  const map = {
    twapNet1h: [],
    twapNet24h: [],
    twapBuy24h: [],
    twapSell24h: []
  };

  currentBuckets.forEach((bucket) => {
      const time = getLocalTimestamp(bucket.timestamp);
    const mode = selectedTwapMode;
    
    const valNet1h = bucket.twapModes?.[mode]?.twapNet1h ?? bucket.twapNet1h;
    const valNet24h = bucket.twapModes?.[mode]?.twapNet24h ?? bucket.twapNet24h;
    const valBuy24h = bucket.twapModes?.[mode]?.twapBuy24h ?? bucket.twapBuy24h;
    const valSell24h = bucket.twapModes?.[mode]?.twapSell24h ?? bucket.twapSell24h;

    if (Number.isFinite(valNet1h)) map.twapNet1h.push({ time, value: valNet1h });
    if (Number.isFinite(valNet24h)) map.twapNet24h.push({ time, value: valNet24h });
    if (Number.isFinite(valBuy24h)) map.twapBuy24h.push({ time, value: valBuy24h });
    if (Number.isFinite(valSell24h)) map.twapSell24h.push({ time, value: valSell24h });
  });

  Object.keys(twapSeriesMap).forEach((key) => {
    twapSeriesMap[key].setData(map[key]);
  });
}

function populatePanelDepthData(panel, metricKey) {
  const metric = panel.activeMetrics[metricKey];
  if (!metric) return;

  const { type, depth, series } = metric;
  const suffix = depth.replace('.', '_');
  const dataset = {
    bybit: [],
    hl: [],
    combined: []
  };

  currentBuckets.forEach((bucket) => {
      const time = getLocalTimestamp(bucket.timestamp);
    const valBybit = bucket[`bybit_${type}_${suffix}`];
    const valHl = bucket[`hl_${type}_${suffix}`];

    if (Number.isFinite(valBybit)) dataset.bybit.push({ time, value: valBybit });
    if (Number.isFinite(valHl)) dataset.hl.push({ time, value: valHl });

    const hasBybit = Number.isFinite(valBybit);
    const hasHl = Number.isFinite(valHl);
    if (hasBybit || hasHl) {
      dataset.combined.push({ time, value: (valBybit || 0) + (valHl || 0) });
    }
  });

  series.bybit.setData(dataset.bybit);
  series.hl.setData(dataset.hl);
  series.combined.setData(dataset.combined);
}

function populatePanelDiffData(panel, metricKey) {
  const metric = panel.activeMetrics[metricKey];
  if (!metric) return;

  const { depth, series } = metric;
  const diffData = [];

  const isCustomDiff = [
    '3B_8A', '8B_3A', '8A_3B', '8B_30A', '5B_15A',
    '15B_5A', '8B_15A', '15B_8A', '15B_30A', '30B_15A',
    '30_15', '30_8', '15_8', '8_5'
  ].includes(depth);

  if (isCustomDiff) {
    const propKey = `diff_${depth}`;
    currentBuckets.forEach((bucket) => {
      const time = getLocalTimestamp(bucket.timestamp);
      const val = bucket[propKey];
      if (val !== null && val !== undefined) {
        diffData.push({ time, value: val });
      }
    });
  } else {
    const suffix = depth.replace('.', '_');
    const source = exchangeSourceSelect.value;

    currentBuckets.forEach((bucket) => {
        const time = getLocalTimestamp(bucket.timestamp);
      const bybitBid = bucket[`bybit_bid_${suffix}`];
      const bybitAsk = bucket[`bybit_ask_${suffix}`];
      const hlBid = bucket[`hl_bid_${suffix}`];
      const hlAsk = bucket[`hl_ask_${suffix}`];

      let bidVal = null;
      let askVal = null;

      if (source === 'bybit') {
        if (Number.isFinite(bybitBid)) bidVal = bybitBid;
        if (Number.isFinite(bybitAsk)) askVal = bybitAsk;
      } else if (source === 'hl') {
        if (Number.isFinite(hlBid)) bidVal = hlBid;
        if (Number.isFinite(hlAsk)) askVal = hlAsk;
      } else {
        // Combined or All: show combined diff
        const hasBybitBid = Number.isFinite(bybitBid);
        const hasHlBid = Number.isFinite(hlBid);
        if (hasBybitBid || hasHlBid) bidVal = (bybitBid || 0) + (hlBid || 0);

        const hasBybitAsk = Number.isFinite(bybitAsk);
        const hasHlAsk = Number.isFinite(hlAsk);
        if (hasBybitAsk || hasHlAsk) askVal = (bybitAsk || 0) + (hlAsk || 0);
      }

      if (bidVal !== null || askVal !== null) {
        diffData.push({ time, value: (bidVal || 0) - (askVal || 0) });
      }
    });
  }

  series.diff.setData(diffData);
}

function populatePanelAvgData(panel, metricKey) {
  const metric = panel.activeMetrics[metricKey];
  if (!metric) return;

  const { depth, series } = metric;
  const avgData = [];
  const suffix = depth.replace('.', '_');
  const source = exchangeSourceSelect.value;

  currentBuckets.forEach((bucket) => {
    const time = getLocalTimestamp(bucket.timestamp);
    const bybitBid = bucket[`bybit_bid_${suffix}`];
    const bybitAsk = bucket[`bybit_ask_${suffix}`];
    const hlBid = bucket[`hl_bid_${suffix}`];
    const hlAsk = bucket[`hl_ask_${suffix}`];

    let bidVal = null;
    let askVal = null;

    if (source === 'bybit') {
      if (Number.isFinite(bybitBid)) bidVal = bybitBid;
      if (Number.isFinite(bybitAsk)) askVal = bybitAsk;
    } else if (source === 'hl') {
      if (Number.isFinite(hlBid)) bidVal = hlBid;
      if (Number.isFinite(hlAsk)) askVal = hlAsk;
    } else {
      // Combined or All: show combined avg ratio
      const hasBybitBid = Number.isFinite(bybitBid);
      const hasHlBid = Number.isFinite(hlBid);
      if (hasBybitBid || hasHlBid) bidVal = (bybitBid || 0) + (hlBid || 0);

      const hasBybitAsk = Number.isFinite(bybitAsk);
      const hasHlAsk = Number.isFinite(hlAsk);
      if (hasBybitAsk || hasHlAsk) askVal = (bybitAsk || 0) + (hlAsk || 0);
    }

    if (bidVal !== null && askVal !== null) {
      const ratio = askVal > 0 ? (bidVal / askVal) : (bidVal === 0 ? 1.0 : 0.0);
      avgData.push({ time, value: ratio });
    }
  });

  series.avg.setData(avgData);
}

function populateAllChartsData() {
  populatePriceData();
  populateTwapData();
  dynamicPanels.forEach((panel) => {
    Object.keys(panel.activeMetrics).forEach((metricKey) => {
      const metric = panel.activeMetrics[metricKey];
      if (metric.type === 'diff') {
        populatePanelDiffData(panel, metricKey);
      } else if (metric.type === 'avg') {
        populatePanelAvgData(panel, metricKey);
      } else {
        populatePanelDepthData(panel, metricKey);
      }
    });
  });
}

// Refresh from Backend
async function refreshChart() {
  try {
    const toDate = new Date();
    let fromDate = new Date();
    
    // Choose appropriate duration to load based on timeframe to keep payload sized reasonably
    switch (selectedTimeframe) {
      case '1m':
        fromDate.setDate(toDate.getDate() - 2); // 2 days of 1m
        break;
      case '5m':
        fromDate.setDate(toDate.getDate() - 10); // 10 days of 5m
        break;
      case '15m':
        fromDate.setDate(toDate.getDate() - 30); // 30 days of 15m
        break;
      case '1h':
        fromDate.setDate(toDate.getDate() - 120); // 120 days of 1h
        break;
      case '4h':
        fromDate.setDate(toDate.getDate() - 480); // 480 days of 4h
        break;
      case '1d':
        fromDate.setFullYear(toDate.getFullYear() - 5); // 5 years of 1d
        break;
      default:
        fromDate.setDate(toDate.getDate() - 2);
    }

    const fromIso = fromDate.toISOString();
    const toIso = toDate.toISOString();

    const response = await fetch(`/api/snapshots/history?timeframe=${encodeURIComponent(selectedTimeframe)}&from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`);
    currentBuckets = await response.json();
    snapshotCount.textContent = String(currentBuckets.length);
    populateAllChartsData();
  } catch (err) {
    console.error('Error refreshing chart snapshot data:', err);
  }
}

// Event Listeners
timeframeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    selectedTimeframe = button.dataset.timeframe;
    timeframeButtons.forEach((item) => item.classList.toggle('active', item === button));
    refreshChart().catch(console.error);
  });
});

twapModeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    selectedTwapMode = button.dataset.twapMode;
    twapModeButtons.forEach((item) => item.classList.toggle('active', item === button));
    populateTwapData();
  });
});

metricInputs.forEach((input) => {
  input.addEventListener('change', () => {
    updateTwapSeriesVisibility();
  });
});

// Dropdown Add Subchart handler
addNewPanelBtn.addEventListener('click', () => {
  createNewPanel();
});

// Global control listeners
exchangeSourceSelect.addEventListener('change', () => {
  updateAllSubcharts();
});

// Presets Implementation
const savePresetModal = document.getElementById('savePresetModal');
const presetNameInput = document.getElementById('presetNameInput');
const saveTimeframeCheckbox = document.getElementById('saveTimeframeCheckbox');
const confirmSavePresetBtn = document.getElementById('confirmSavePresetBtn');
const cancelSavePresetBtn = document.getElementById('cancelSavePresetBtn');
const presetSelect = document.getElementById('presetSelect');
const deletePresetBtn = document.getElementById('deletePresetBtn');
const savePresetBtn = document.getElementById('savePresetBtn');
const sharePresetBtn = document.getElementById('sharePresetBtn');
const presetFeedback = document.getElementById('presetFeedback');

let activePresets = {};

async function initializePresets() {
  const isUserLoggedIn = !!(currentUser && currentUser.id);
  if (isUserLoggedIn) {
    try {
      const response = await fetch('/api/presets');
      if (response.ok) {
        const list = await response.json();
        activePresets = {};
        list.forEach(item => {
          activePresets[item.name] = item.preset_data;
        });
      } else {
        throw new Error('Failed to load presets');
      }
    } catch (err) {
      console.error('Failed to load presets from server, falling back to local:', err);
      const presetKey = `hype_chart_presets_${currentUser.id}`;
      activePresets = JSON.parse(localStorage.getItem(presetKey) || '{}');
    }
  } else {
    activePresets = JSON.parse(localStorage.getItem('hype_chart_presets_public') || '{}');
  }
  populatePresetSelectDropdown();
}

async function saveCurrentAsPreset(presetName, includeTimeframe) {
  const panelsData = dynamicPanels.map((panel) => {
    const metrics = Object.keys(panel.activeMetrics).map((metricKey) => {
      const m = panel.activeMetrics[metricKey];
      return { type: m.type, depth: m.depth, color: m.color };
    });
    return { metrics };
  });

  const presetData = {
    name: presetName,
    exchange: exchangeSourceSelect.value,
    timeframe: includeTimeframe ? selectedTimeframe : null,
    panels: panelsData
  };

  activePresets[presetName] = presetData;
  populatePresetSelectDropdown();

  const isUserLoggedIn = !!(currentUser && currentUser.id);
  if (isUserLoggedIn) {
    try {
      await fetch('/api/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: presetName, preset_data: presetData })
      });
      const presetKey = `hype_chart_presets_${currentUser.id}`;
      localStorage.setItem(presetKey, JSON.stringify(activePresets));
    } catch (err) {
      console.error('Failed to sync saved preset to server:', err);
    }
  } else {
    localStorage.setItem('hype_chart_presets_public', JSON.stringify(activePresets));
  }
}

function loadPreset(presetName) {
  const preset = activePresets[presetName];
  if (!preset) return;

  // 1. Clear all existing panels (create a copy to prevent mutation bugs)
  const panelIds = dynamicPanels.map(p => p.panelId);
  panelIds.forEach(id => removePanel(id));

  // 2. Set global exchange source
  if (preset.exchange) {
    exchangeSourceSelect.value = preset.exchange;
  }

  // 3. Set timeframe if stored in preset
  if (preset.timeframe) {
    selectedTimeframe = preset.timeframe;
    timeframeButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.timeframe === selectedTimeframe);
    });
    refreshChart().catch(console.error);
  }

  // 4. Rebuild panels
  preset.panels.forEach((panelData) => {
    createNewPanel();
    const newPanel = dynamicPanels[dynamicPanels.length - 1];
    if (newPanel) {
      panelData.metrics.forEach((metric) => {
        addMetricToPanel(newPanel.panelId, metric.type, metric.depth, metric.color);
      });
    }
  });

  updateAllSubcharts();
  populateAllChartsData();
}

async function deletePreset(presetName) {
  if (!presetName) return;
  if (activePresets[presetName]) {
    delete activePresets[presetName];
    populatePresetSelectDropdown();

    const isUserLoggedIn = !!(currentUser && currentUser.id);
    if (isUserLoggedIn) {
      try {
        await fetch(`/api/presets/${encodeURIComponent(presetName)}`, {
          method: 'DELETE'
        });
        const presetKey = `hype_chart_presets_${currentUser.id}`;
        localStorage.setItem(presetKey, JSON.stringify(activePresets));
      } catch (err) {
        console.error('Failed to sync deleted preset to server:', err);
      }
    } else {
      localStorage.setItem('hype_chart_presets_public', JSON.stringify(activePresets));
    }
  }
}

function populatePresetSelectDropdown() {
  if (!presetSelect) return;
  const lang = localStorage.getItem('hype_twap_lang') || 'en';
  const t = TRANSLATIONS[lang];
  presetSelect.innerHTML = `<option value="" disabled selected>${t ? t.loadPreset : 'Load Preset...'}</option>`;

  Object.keys(activePresets).forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    presetSelect.appendChild(opt);
  });
}

function showSaveModal() {
  presetNameInput.value = '';
  const label = saveTimeframeCheckbox.parentElement;
  if (label) {
    label.innerHTML = `<input type="checkbox" id="saveTimeframeCheckbox" checked> Include current timeframe (${selectedTimeframe})`;
  }
  savePresetModal.classList.remove('hidden');
  presetNameInput.focus();
}

function hideSaveModal() {
  savePresetModal.classList.add('hidden');
}

// Preset Event Listeners
savePresetBtn.addEventListener('click', showSaveModal);
if (sharePresetBtn) {
  sharePresetBtn.addEventListener('click', shareCurrentPreset);
}
cancelSavePresetBtn.addEventListener('click', hideSaveModal);

confirmSavePresetBtn.addEventListener('click', () => {
  const name = presetNameInput.value.trim();
  if (!name) {
    alert('Please enter a preset name.');
    return;
  }
  const includeTf = document.getElementById('saveTimeframeCheckbox').checked;
  saveCurrentAsPreset(name, includeTf);
  hideSaveModal();
});

presetSelect.addEventListener('change', (e) => {
  const val = e.target.value;
  if (!val) return;
  loadPreset(val);
});

deletePresetBtn.addEventListener('click', () => {
  const val = presetSelect.value;
  if (!val) {
    alert('Please select a preset to delete from the dropdown.');
    return;
  }
  if (confirm(`Are you sure you want to delete preset "${val}"?`)) {
    deletePreset(val);
    presetSelect.value = '';
  }
});

// Share Preset & Timeframe implementation
function shareCurrentPreset() {
  const lang = localStorage.getItem('hype_twap_lang') || 'en';
  const t = TRANSLATIONS[lang];

  const panelsData = dynamicPanels.map((panel) => {
    const metrics = Object.keys(panel.activeMetrics).map((metricKey) => {
      const m = panel.activeMetrics[metricKey];
      return { type: m.type, depth: m.depth, color: m.color };
    });
    return { metrics };
  });

  const presetData = {
    exchange: exchangeSourceSelect.value,
    timeframe: selectedTimeframe,
    panels: panelsData
  };

  const jsonString = JSON.stringify(presetData);
  const base64Data = btoa(unescape(encodeURIComponent(jsonString)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const url = new URL(window.location.href);
  url.searchParams.set('share', base64Data);
  const shareUrl = url.toString();

  navigator.clipboard.writeText(shareUrl).then(() => {
    if (presetFeedback) {
      showAlertFeedback(presetFeedback, t.linkCopied || 'Link copied to clipboard!', true);
    } else {
      alert(t.linkCopied || 'Link copied to clipboard!');
    }
  }).catch((err) => {
    console.error('Failed to copy link:', err);
    if (presetFeedback) {
      showAlertFeedback(presetFeedback, lang === 'en' ? 'Failed to copy link.' : 'Не удалось скопировать ссылку.', false);
    } else {
      alert(lang === 'en' ? `Copy link manually: ${shareUrl}` : `Скопируйте ссылку вручную: ${shareUrl}`);
    }
  });
}

function applySharedPreset(preset) {
  if (!preset) return;

  // 1. Clear all existing panels
  const panelIds = dynamicPanels.map(p => p.panelId);
  panelIds.forEach(id => removePanel(id));

  // 2. Set global exchange source
  if (preset.exchange) {
    exchangeSourceSelect.value = preset.exchange;
  }

  // 3. Set timeframe if stored in preset
  if (preset.timeframe) {
    selectedTimeframe = preset.timeframe;
    timeframeButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.timeframe === selectedTimeframe);
    });
    refreshChart().catch(console.error);
  }

  // 4. Rebuild panels
  if (preset.panels && Array.isArray(preset.panels)) {
    preset.panels.forEach((panelData) => {
      createNewPanel();
      const newPanel = dynamicPanels[dynamicPanels.length - 1];
      if (newPanel && panelData.metrics && Array.isArray(panelData.metrics)) {
        panelData.metrics.forEach((metric) => {
          addMetricToPanel(newPanel.panelId, metric.type, metric.depth, metric.color);
        });
      }
    });
  }

  updateAllSubcharts();
  populateAllChartsData();
}

function checkAndLoadSharedPreset() {
  const urlParams = new URLSearchParams(window.location.search);
  const shareData = urlParams.get('share');
  if (shareData) {
    try {
      let base64 = shareData.replace(/-/g, '+').replace(/_/g, '/');
      while (base64.length % 4) {
        base64 += '=';
      }
      const jsonString = decodeURIComponent(escape(atob(base64)));
      const preset = JSON.parse(jsonString);
      applySharedPreset(preset);
      return true;
    } catch (err) {
      console.error('Failed to parse shared preset data:', err);
    }
  }
  return false;
}

// ==========================================
// CHART RULER TOOL IMPLEMENTATION
// ==========================================

let isRulerModeActive = false;

function updateRulerOverlays() {
  activeCharts.forEach((chart) => {
    const container = chart._container;
    if (!container) return;

    let canvas = container.querySelector('.ruler-canvas');
    if (isRulerModeActive) {
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.className = 'ruler-canvas';
        canvas.style.position = 'absolute';
        canvas.style.top = '0';
        canvas.style.left = '0';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.zIndex = '100';
        canvas.style.cursor = 'crosshair';
        canvas.style.pointerEvents = 'auto';

        const rect = container.getBoundingClientRect();
        canvas.width = rect.width;
        canvas.height = rect.height;

        container.appendChild(canvas);
        setupRulerEvents(canvas, chart);
      } else {
        canvas.style.display = 'block';
        canvas.style.pointerEvents = 'auto';
      }
    } else {
      if (canvas) {
        canvas.style.display = 'none';
        canvas.style.pointerEvents = 'none';
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        canvas.measureState = null;
      }
    }
  });
}

function setupRulerEvents(canvas, chart) {
  canvas.drawRuler = () => drawRuler(canvas, chart);

  canvas.addEventListener('mousedown', (e) => {
    e.preventDefault();
    canvas.measureState = {
      startX: e.offsetX,
      startY: e.offsetY,
      currentX: e.offsetX,
      currentY: e.offsetY,
      isDrawing: true,
      locked: false
    };
    canvas.drawRuler();
  });

  canvas.addEventListener('mousemove', (e) => {
    e.preventDefault();
    canvas.hoverX = e.offsetX;
    canvas.hoverY = e.offsetY;

    const state = canvas.measureState;
    if (state && state.isDrawing) {
      state.currentX = e.offsetX;
      state.currentY = e.offsetY;
    }
    canvas.drawRuler();
  });

  canvas.addEventListener('mouseup', (e) => {
    e.preventDefault();
    const state = canvas.measureState;
    if (state && state.isDrawing) {
      state.isDrawing = false;
      state.locked = true;
      canvas.drawRuler();
    }
  });

  canvas.addEventListener('mouseenter', (e) => {
    canvas.hoverX = e.offsetX;
    canvas.hoverY = e.offsetY;
    canvas.drawRuler();
  });

  canvas.addEventListener('mouseleave', (e) => {
    canvas.hoverX = undefined;
    canvas.hoverY = undefined;
    const state = canvas.measureState;
    if (state && state.isDrawing) {
      state.isDrawing = false;
      state.locked = true;
    }
    canvas.drawRuler();
  });
}

function drawRuler(canvas, chart) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const state = canvas.measureState;
  const hoverX = canvas.hoverX;
  const hoverY = canvas.hoverY;

  // 1. Draw crosshair guidelines
  if (hoverX !== undefined && hoverY !== undefined) {
    ctx.save();
    ctx.strokeStyle = 'rgba(129, 144, 139, 0.3)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    
    ctx.beginPath();
    ctx.moveTo(0, hoverY);
    ctx.lineTo(canvas.width, hoverY);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(hoverX, 0);
    ctx.lineTo(hoverX, canvas.height);
    ctx.stroke();
    ctx.restore();
  }

  if (!state) return;

  const { startX, startY, currentX, currentY } = state;
  const series = chart._syncSeries;
  if (!series) return;

  const startVal = series.coordinateToPrice(startY);
  const currentVal = series.coordinateToPrice(currentY);

  if (startVal === null || currentVal === null || startVal === undefined || currentVal === undefined) {
    return;
  }

  ctx.save();

  const isUp = currentVal >= startVal;
  const colorBase = isUp ? '53, 208, 131' : '239, 94, 94';
  const fillColor = `rgba(${colorBase}, 0.12)`;
  const strokeColor = `rgba(${colorBase}, 0.85)`;

  // Rect fill
  ctx.fillStyle = fillColor;
  ctx.fillRect(startX, startY, currentX - startX, currentY - startY);

  // Rect border
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(startX, startY, currentX - startX, currentY - startY);

  // Diagonal connection
  ctx.strokeStyle = strokeColor;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(startX, startY);
  ctx.lineTo(currentX, currentY);
  ctx.stroke();

  // Anchors
  ctx.fillStyle = strokeColor;
  ctx.beginPath();
  ctx.arc(startX, startY, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(currentX, currentY, 4, 0, Math.PI * 2);
  ctx.fill();

  // Label percentage calculation
  const deltaVal = currentVal - startVal;
  const pctChange = startVal !== 0 ? (deltaVal / Math.abs(startVal)) * 100 : 0;

  const sign = deltaVal >= 0 ? '+' : '';
  let startPriceStr = '';
  let endPriceStr = '';
  let deltaStr = '';

  if (chart._type === 'price') {
    startPriceStr = `$${startVal.toFixed(4)}`;
    endPriceStr = `$${currentVal.toFixed(4)}`;
    deltaStr = `${sign}${deltaVal.toFixed(4)}`;
  } else {
    startPriceStr = formatKandM(startVal);
    endPriceStr = formatKandM(currentVal);
    deltaStr = `${sign}${formatKandM(deltaVal)}`;
  }

  const line1 = `${startPriceStr} → ${endPriceStr}`;
  const line2 = `${deltaStr} (${sign}${pctChange.toFixed(2)}%)`;

  // Determine price scale width dynamically
  let scaleWidth = 65;
  try {
    if (chart && typeof chart.priceScale === 'function') {
      const pScale = chart.priceScale('right');
      if (pScale && typeof pScale.width === 'function') {
        scaleWidth = pScale.width();
      }
    }
  } catch (e) {
    console.error('Error getting price scale width:', e);
  }
  if (!scaleWidth || scaleWidth <= 0) scaleWidth = 65;

  const axisX = canvas.width - scaleWidth;
  const midY = (startY + currentY) / 2;

  // Render Start Price Tag on the axis
  ctx.fillStyle = '#263137'; // dark neutral gray for start price
  ctx.fillRect(axisX, startY - 9, scaleWidth - 2, 18);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 10px Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(startPriceStr, axisX + (scaleWidth - 2) / 2, startY);

  // Render End Price Tag on the axis
  ctx.fillStyle = strokeColor; // Trend color (green or red)
  ctx.fillRect(axisX, currentY - 9, scaleWidth - 2, 18);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 10px Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(endPriceStr, axisX + (scaleWidth - 2) / 2, currentY);

  // Render Delta / Percentage Tooltip (pinned next to axis)
  ctx.font = 'bold 11px Segoe UI, sans-serif';
  const labelWidth = ctx.measureText(line2).width;
  const paddingX = 8;
  const paddingY = 5;
  const rectW = labelWidth + paddingX * 2;
  const rectH = 22;

  const rectX = axisX - rectW - 6;
  const rectY = midY - rectH / 2;

  ctx.fillStyle = 'rgba(17, 22, 26, 0.96)';
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1;
  
  ctx.beginPath();
  const radius = 4;
  ctx.moveTo(rectX + radius, rectY);
  ctx.lineTo(rectX + rectW - radius, rectY);
  ctx.quadraticCurveTo(rectX + rectW, rectY, rectX + rectW, rectY + radius);
  ctx.lineTo(rectX + rectW, rectY + rectH - radius);
  ctx.quadraticCurveTo(rectX + rectW, rectY + rectH, rectX + rectW - radius, rectY + rectH);
  ctx.lineTo(rectX + radius, rectY + rectH);
  ctx.quadraticCurveTo(rectX, rectY + rectH, rectX, rectY + rectH - radius);
  ctx.lineTo(rectX, rectY + radius);
  ctx.quadraticCurveTo(rectX, rectY, rectX + radius, rectY);
  ctx.closePath();
  
  ctx.fill();
  ctx.stroke();

  // Draw delta and percentage text inside the box
  ctx.fillStyle = isUp ? '#35d083' : '#ef5e5e';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(line2, rectX + rectW / 2, midY + 1);

  ctx.restore();
}

// Register click listener for the ruler button
const rulerToggleBtn = document.querySelector('#rulerToggleBtn');
if (rulerToggleBtn) {
  rulerToggleBtn.addEventListener('click', () => {
    isRulerModeActive = !isRulerModeActive;
    rulerToggleBtn.classList.toggle('active', isRulerModeActive);
    updateRulerOverlays();
  });
}

// ==========================================
// TELEGRAM ALERTS CONFIGURATOR FRONTEND
// ==========================================

const alertElements = {
  toggleSettingsBtn: document.querySelector('#toggleSettingsBtn'),
  settingsDrawer: document.querySelector('#settingsDrawer'),
  tgTokenInput: document.querySelector('#tgTokenInput'),
  tgChatIdInput: document.querySelector('#tgChatIdInput'),
  saveConfigBtn: document.querySelector('#saveConfigBtn'),
  testBotBtn: document.querySelector('#testBotBtn'),
  settingsMessage: document.querySelector('#settingsMessage'),

  tabActiveAlerts: document.querySelector('#tabActiveAlerts'),
  tabCreateAlert: document.querySelector('#tabCreateAlert'),
  tabBacktest: document.querySelector('#tabBacktest'),
  tabContentList: document.querySelector('#tabContentList'),
  tabContentForm: document.querySelector('#tabContentForm'),
  tabContentBacktest: document.querySelector('#tabContentBacktest'),
  alertsCount: document.querySelector('#alertsCount'),
  alertsList: document.querySelector('#alertsList'),

  createAlertForm: document.querySelector('#createAlertForm'),
  alertNameInput: document.querySelector('#alertNameInput'),
  addConditionBtn: document.querySelector('#addConditionBtn'),
  logicalOperatorSelect: document.querySelector('#logicalOperatorSelect'),
  logicalOperatorGroup: document.querySelector('#logicalOperatorGroup'),
  conditionsContainer: document.querySelector('#conditionsContainer'),
  trendModeSelect: document.querySelector('#trendModeSelect'),
  alertTimeframeSelect: document.querySelector('#alertTimeframeSelect'),
  frequencySelect: document.querySelector('#frequencySelect'),
  formFeedback: document.querySelector('#formFeedback'),
  editAlertId: document.querySelector('#editAlertId')
};

const METRIC_LABELS = {
  en: {
    price: 'HYPE Price',
    twapNet1h: 'TWAP Net 1H',
    twapNet24h: 'TWAP Net 24H',
    twapBuy24h: 'TWAP Buy 24H',
    twapSell24h: 'TWAP Sell 24H',
    activeBuyCount: 'Active Buy Count',
    activeSellCount: 'Active Sell Count'
  },
  ru: {
    price: 'Цена HYPE',
    twapNet1h: 'TWAP Чистый 1Ч',
    twapNet24h: 'TWAP Чистый 24Ч',
    twapBuy24h: 'TWAP Покупки 24Ч',
    twapSell24h: 'TWAP Продажи 24Ч',
    activeBuyCount: 'Кол-во активных покупок',
    activeSellCount: 'Кол-во активных продаж'
  }
};

const depthsList = [1.5, 3, 5, 8, 15, 30, 60];
depthsList.forEach(d => {
  const suffix = String(d).replace('.', '_');
  METRIC_LABELS.en[`hl_bid_${suffix}`] = `HL Bid ${d}%`;
  METRIC_LABELS.en[`hl_ask_${suffix}`] = `HL Ask ${d}%`;
  METRIC_LABELS.en[`bybit_bid_${suffix}`] = `Bybit Bid ${d}%`;
  METRIC_LABELS.en[`bybit_ask_${suffix}`] = `Bybit Ask ${d}%`;
  METRIC_LABELS.en[`hl_avg_${suffix}`] = `HL Avg ${d}%`;
  METRIC_LABELS.en[`bybit_avg_${suffix}`] = `Bybit Avg ${d}%`;

  METRIC_LABELS.ru[`hl_bid_${suffix}`] = `HL Бид ${d}%`;
  METRIC_LABELS.ru[`hl_ask_${suffix}`] = `HL Аск ${d}%`;
  METRIC_LABELS.ru[`bybit_bid_${suffix}`] = `Bybit Бид ${d}%`;
  METRIC_LABELS.ru[`bybit_ask_${suffix}`] = `Bybit Аск ${d}%`;
  METRIC_LABELS.ru[`hl_avg_${suffix}`] = `HL Avg ${d}%`;
  METRIC_LABELS.ru[`bybit_avg_${suffix}`] = `Bybit Avg ${d}%`;
});

const customDiffLabels = {
  diff_3B_8A: 'DIFF 3B-8A',
  diff_8B_3A: 'DIFF 8B-3A',
  diff_8A_3B: 'DIFF 8A-3B',
  diff_8B_30A: 'DIFF 8B-30A',
  diff_5B_15A: 'DIFF 5B-15A',
  diff_15B_5A: 'DIFF 15B-5A',
  diff_8B_15A: 'DIFF 8B-15A',
  diff_15B_8A: 'DIFF 15B-8A',
  diff_15B_30A: 'DIFF 15B-30A',
  diff_30B_15A: 'DIFF 30B-15A',
  diff_30_15: 'DIFF 30-15',
  diff_30_8: 'DIFF 30-8',
  diff_15_8: 'DIFF 15-8',
  diff_8_5: 'DIFF 8-5'
};
Object.assign(METRIC_LABELS.en, customDiffLabels);
Object.assign(METRIC_LABELS.ru, customDiffLabels);

function populateMetricSelect(select, lang) {
  select.innerHTML = '';
  
  // Basic metrics
  const basicMetrics = [
    { value: 'price', label: METRIC_LABELS[lang].price },
    { value: 'twapNet1h', label: METRIC_LABELS[lang].twapNet1h },
    { value: 'twapNet24h', label: METRIC_LABELS[lang].twapNet24h },
    { value: 'twapBuy24h', label: METRIC_LABELS[lang].twapBuy24h },
    { value: 'twapSell24h', label: METRIC_LABELS[lang].twapSell24h },
    { value: 'activeBuyCount', label: METRIC_LABELS[lang].activeBuyCount },
    { value: 'activeSellCount', label: METRIC_LABELS[lang].activeSellCount }
  ];
  
  basicMetrics.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.value;
    opt.textContent = m.label;
    select.appendChild(opt);
  });

  const optGroupHlBid = document.createElement('optgroup');
  optGroupHlBid.label = lang === 'en' ? 'Hyperliquid Bid Depth' : 'Hyperliquid Бид Глубина';
  const optGroupHlAsk = document.createElement('optgroup');
  optGroupHlAsk.label = lang === 'en' ? 'Hyperliquid Ask Depth' : 'Hyperliquid Аск Глубина';
  const optGroupBybitBid = document.createElement('optgroup');
  optGroupBybitBid.label = lang === 'en' ? 'Bybit Bid Depth' : 'Bybit Бид Глубина';
  const optGroupBybitAsk = document.createElement('optgroup');
  optGroupBybitAsk.label = lang === 'en' ? 'Bybit Ask Depth' : 'Bybit Аск Глубина';

  const optGroupHlAvg = document.createElement('optgroup');
  optGroupHlAvg.label = lang === 'en' ? 'Hyperliquid Avg Ratio (Bid/Ask)' : 'Hyperliquid Avg Коэффициент (Бид/Аск)';
  const optGroupBybitAvg = document.createElement('optgroup');
  optGroupBybitAvg.label = lang === 'en' ? 'Bybit Avg Ratio (Bid/Ask)' : 'Bybit Avg Коэффициент (Бид/Аск)';

  depthsList.forEach(d => {
    const suffix = String(d).replace('.', '_');

    const optHlBid = document.createElement('option');
    optHlBid.value = `hl_bid_${suffix}`;
    optHlBid.textContent = lang === 'en' ? `HL Bid ${d}%` : `HL Бид ${d}%`;
    optGroupHlBid.appendChild(optHlBid);

    const optHlAsk = document.createElement('option');
    optHlAsk.value = `hl_ask_${suffix}`;
    optHlAsk.textContent = lang === 'en' ? `HL Ask ${d}%` : `HL Аск ${d}%`;
    optGroupHlAsk.appendChild(optHlAsk);

    const optBybitBid = document.createElement('option');
    optBybitBid.value = `bybit_bid_${suffix}`;
    optBybitBid.textContent = lang === 'en' ? `Bybit Bid ${d}%` : `Bybit Бид ${d}%`;
    optGroupBybitBid.appendChild(optBybitBid);

    const optBybitAsk = document.createElement('option');
    optBybitAsk.value = `bybit_ask_${suffix}`;
    optBybitAsk.textContent = lang === 'en' ? `Bybit Ask ${d}%` : `Bybit Аск ${d}%`;
    optGroupBybitAsk.appendChild(optBybitAsk);

    const optHlAvg = document.createElement('option');
    optHlAvg.value = `hl_avg_${suffix}`;
    optHlAvg.textContent = lang === 'en' ? `HL Avg ${d}%` : `HL Avg ${d}%`;
    optGroupHlAvg.appendChild(optHlAvg);

    const optBybitAvg = document.createElement('option');
    optBybitAvg.value = `bybit_avg_${suffix}`;
    optBybitAvg.textContent = lang === 'en' ? `Bybit Avg ${d}%` : `Bybit Avg ${d}%`;
    optGroupBybitAvg.appendChild(optBybitAvg);
  });

  select.appendChild(optGroupHlBid);
  select.appendChild(optGroupHlAsk);
  select.appendChild(optGroupBybitBid);
  select.appendChild(optGroupBybitAsk);
  select.appendChild(optGroupHlAvg);
  select.appendChild(optGroupBybitAvg);

  const optGroupDiff = document.createElement('optgroup');
  optGroupDiff.label = lang === 'en' ? 'Difference Metrics (DIFF)' : 'Метрики разности (DIFF)';
  const customDiffKeys = [
    'diff_3B_8A', 'diff_8B_3A', 'diff_8A_3B', 'diff_8B_30A', 'diff_5B_15A',
    'diff_15B_5A', 'diff_8B_15A', 'diff_15B_8A', 'diff_15B_30A', 'diff_30B_15A',
    'diff_30_15', 'diff_30_8', 'diff_15_8', 'diff_8_5'
  ];
  customDiffKeys.forEach(key => {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = METRIC_LABELS[lang][key] || key;
    optGroupDiff.appendChild(opt);
  });
  select.appendChild(optGroupDiff);
}

function createConditionRow(data = null) {
  const lang = localStorage.getItem('hype_twap_lang') || 'en';
  const t = TRANSLATIONS[lang];

  const row = document.createElement('div');
  row.className = 'condition-row';
  row.style.display = 'flex';
  row.style.flexDirection = 'column';
  row.style.gap = '8px';
  row.style.background = 'rgba(15, 19, 23, 0.4)';
  row.style.border = '1px solid var(--line)';
  row.style.borderRadius = '6px';
  row.style.padding = '12px';
  row.style.position = 'relative';

  row.innerHTML = `
    <button type="button" class="remove-condition-btn" style="position: absolute; right: 10px; top: 10px; background: transparent; border: 0; color: #ff5252; cursor: pointer; font-size: 14px; padding: 2px;">✕</button>
    
    <div style="display: grid; grid-template-columns: 2fr 1fr 2fr; gap: 8px; align-items: end;">
      <div class="form-group" style="margin-bottom: 0;">
        <label class="lbl-left-metric" style="font-size: 10px; text-transform: uppercase; color: var(--muted); margin-bottom: 4px;">${t.leftMetric}</label>
        <select class="metric-select left-metric-select" required style="font-size: 12px; padding: 6px; background: #0f1317; border: 1px solid var(--line); color: var(--text); border-radius: 4px; width: 100%;">
        </select>
      </div>

      <div class="form-group" style="margin-bottom: 0;">
        <label class="lbl-operator" style="font-size: 10px; text-transform: uppercase; color: var(--muted); margin-bottom: 4px;">${t.operator}</label>
        <select class="operator-select" required style="font-size: 12px; padding: 6px; background: #0f1317; border: 1px solid var(--line); color: var(--text); border-radius: 4px; width: 100%;">
          <option value="gt">&gt;</option>
          <option value="lt">&lt;</option>
          <option value="gte">&gt;=</option>
          <option value="lte">&lt;=</option>
        </select>
      </div>

      <div class="form-group" style="margin-bottom: 0;">
        <label class="lbl-compare-with" style="font-size: 10px; text-transform: uppercase; color: var(--muted); margin-bottom: 4px;">${t.compareWith}</label>
        <select class="compare-type-select" required style="font-size: 12px; padding: 6px; background: #0f1317; border: 1px solid var(--line); color: var(--text); border-radius: 4px; width: 100%;">
          <option value="value">${t.staticValue}</option>
          <option value="metric">${t.anotherMetric}</option>
        </select>
      </div>
    </div>

    <div class="target-value-group form-group" style="margin-bottom: 0;">
      <label class="lbl-target-value" style="font-size: 10px; text-transform: uppercase; color: var(--muted); margin-bottom: 4px;">${t.targetValue}</label>
      <input type="number" step="any" class="target-value-input" placeholder="${lang === 'en' ? 'e.g. 30000000 (for $30M)' : 'напр. 30000000 (для $30M)'}" required style="font-size: 12px; padding: 6px; background: #0f1317; border: 1px solid var(--line); color: var(--text); border-radius: 4px; width: 100%;"/>
    </div>

    <div class="target-metric-group form-group hidden" style="margin-bottom: 0;">
      <label class="lbl-right-metric" style="font-size: 10px; text-transform: uppercase; color: var(--muted); margin-bottom: 4px;">${t.rightMetric}</label>
      <select class="metric-select right-metric-select" style="font-size: 12px; padding: 6px; background: #0f1317; border: 1px solid var(--line); color: var(--text); border-radius: 4px; width: 100%;">
      </select>
    </div>
  `;

  const leftSelect = row.querySelector('.left-metric-select');
  const rightSelect = row.querySelector('.right-metric-select');
  populateMetricSelect(leftSelect, lang);
  populateMetricSelect(rightSelect, lang);

  const compareTypeSelect = row.querySelector('.compare-type-select');
  const valueGroup = row.querySelector('.target-value-group');
  const metricGroup = row.querySelector('.target-metric-group');
  const valueInput = row.querySelector('.target-value-input');

  compareTypeSelect.addEventListener('change', () => {
    if (compareTypeSelect.value === 'value') {
      valueGroup.classList.remove('hidden');
      metricGroup.classList.add('hidden');
      valueInput.required = true;
    } else {
      valueGroup.classList.add('hidden');
      metricGroup.classList.remove('hidden');
      valueInput.required = false;
    }
  });

  row.querySelector('.remove-condition-btn').addEventListener('click', () => {
    row.remove();
    updateLogicalOperatorVisibility();
  });

  if (data) {
    leftSelect.value = data.field1;
    row.querySelector('.operator-select').value = data.operator;
    compareTypeSelect.value = data.compareType;
    if (data.compareType === 'value') {
      valueInput.value = data.value;
      valueGroup.classList.remove('hidden');
      metricGroup.classList.add('hidden');
      valueInput.required = true;
    } else {
      rightSelect.value = data.field2;
      valueGroup.classList.add('hidden');
      metricGroup.classList.remove('hidden');
      valueInput.required = false;
    }
  }

  return row;
}

function updateLogicalOperatorVisibility() {
  const container = alertElements.conditionsContainer;
  const logicalOpGroup = alertElements.logicalOperatorGroup;
  if (!container || !logicalOpGroup) return;
  const rows = container.querySelectorAll('.condition-row');
  const rowsCount = rows.length;
  
  if (rowsCount > 1) {
    logicalOpGroup.classList.remove('hidden');
    rows.forEach(row => {
      let removeBtn = row.querySelector('.remove-condition-btn');
      if (!removeBtn) {
        removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'remove-condition-btn';
        removeBtn.style.position = 'absolute';
        removeBtn.style.right = '10px';
        removeBtn.style.top = '10px';
        removeBtn.style.background = 'transparent';
        removeBtn.style.border = '0';
        removeBtn.style.color = '#ff5252';
        removeBtn.style.cursor = 'pointer';
        removeBtn.style.fontSize = '14px';
        removeBtn.style.padding = '2px';
        removeBtn.innerHTML = '✕';
        removeBtn.addEventListener('click', () => {
          row.remove();
          updateLogicalOperatorVisibility();
        });
        row.appendChild(removeBtn);
      }
    });
  } else {
    logicalOpGroup.classList.add('hidden');
    rows.forEach(row => {
      const removeBtn = row.querySelector('.remove-condition-btn');
      if (removeBtn) removeBtn.remove();
    });
  }
}

function resetAlertFormToDefault() {
  alertElements.createAlertForm.reset();
  const container = alertElements.conditionsContainer;
  if (container) {
    container.innerHTML = '';
    const row = createConditionRow();
    container.appendChild(row);
  }
  updateLogicalOperatorVisibility();
}

function showAlertFeedback(element, text, isSuccess) {
  element.textContent = text;
  element.className = `feedback-msg ${isSuccess ? 'success' : 'error'}`;
  setTimeout(() => {
    element.textContent = '';
    element.className = 'feedback-msg';
  }, 4000);
}

async function loadTelegramConfig() {
  try {
    const response = await fetch('/api/config/telegram');
    const config = await response.json();
    if (config.telegramBotTokenMasked) {
      alertElements.tgTokenInput.value = config.telegramBotTokenMasked;
    }
    if (config.telegramChatId) {
      alertElements.tgChatIdInput.value = config.telegramChatId;
    }
  } catch (err) {
    console.error('Failed to load Telegram settings:', err);
  }
}

async function saveTelegramConfig() {
  const token = alertElements.tgTokenInput.value.trim();
  const chatId = alertElements.tgChatIdInput.value.trim();
  const lang = localStorage.getItem('hype_twap_lang') || 'en';

  try {
    const response = await fetch('/api/config/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, chatId })
    });
    if (!response.ok) throw new Error('Save config failed');
    showAlertFeedback(alertElements.settingsMessage, lang === 'en' ? 'Settings saved successfully.' : 'Настройки сохранены.', true);
    await loadTelegramConfig();
    await checkAuthState(); // Bot username could have changed
  } catch (err) {
    showAlertFeedback(alertElements.settingsMessage, lang === 'en' ? 'Failed to save settings.' : 'Ошибка при сохранении настроек.', false);
  }
}

async function testTelegramConnection() {
  const token = alertElements.tgTokenInput.value.trim();
  const chatId = alertElements.tgChatIdInput.value.trim();
  const lang = localStorage.getItem('hype_twap_lang') || 'en';

  alertElements.testBotBtn.disabled = true;
  alertElements.testBotBtn.textContent = lang === 'en' ? 'Testing...' : 'Проверка...';
  try {
    const response = await fetch('/api/alerts/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, chatId })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Connection failed');
    showAlertFeedback(alertElements.settingsMessage, lang === 'en' ? 'Test alert sent! Check your Telegram.' : 'Тестовый алерт отправлен! Проверьте Telegram.', true);
  } catch (err) {
    showAlertFeedback(alertElements.settingsMessage, lang === 'en' ? `Test failed: ${err.message}` : `Ошибка: ${err.message}`, false);
  } finally {
    alertElements.testBotBtn.disabled = false;
    alertElements.testBotBtn.textContent = lang === 'en' ? 'Test Connection' : 'Проверить соединение';
  }
}

async function loadAlerts() {
  try {
    const response = await fetch('/api/alerts');
    const alerts = await response.json();
    cachedAlerts = alerts;
    alertElements.alertsCount.textContent = String(alerts.length);
    renderAlertsList(alerts);
  } catch (err) {
    console.error('Failed to load alerts:', err);
  }
}

let isAuthenticated = false;
let currentUser = null;

function renderAlertsList(alerts) {
  const container = alertElements.alertsList;
  container.innerHTML = '';
  const lang = localStorage.getItem('hype_twap_lang') || 'en';
  const labels = METRIC_LABELS[lang];

  if (alerts.length === 0) {
    container.innerHTML = `<p class="placeholder-text">${lang === 'en' ? 'No alerts configured yet.' : 'Алерты не настроены.'}</p>`;
    return;
  }

  alerts.forEach(alert => {
    const item = document.createElement('div');
    item.className = 'alert-item';

    const expr = alert.expression;
    let ruleString = '';
    if (expr && expr.type === 'compound') {
      const logicalConnector = ` ${expr.logicalOperator.toUpperCase()} `;
      ruleString = expr.conditions.map(cond => {
        const left = labels[cond.field1] || cond.field1;
        const op = { gt: '>', lt: '<', gte: '>=', lte: '<=' }[cond.operator] || cond.operator;
        const right = cond.compareType === 'value' ? formatStaticValue(cond.field1, cond.value) : (labels[cond.field2] || cond.field2);
        return `${left} ${op} ${right}`;
      }).join(logicalConnector);
    } else if (expr) {
      const leftName = labels[expr.field1] || expr.field1;
      const rightName = expr.compareType === 'value' ? formatStaticValue(expr.field1, expr.value) : (labels[expr.field2] || expr.field2);
      const opLabel = { gt: '>', lt: '<', gte: '>=', lte: '<=' }[expr.operator] || expr.operator;
      ruleString = `${leftName} ${opLabel} ${rightName}`;
    }
    const tfString = alert.timeframe || '1m';
    const cooldownString = alert.frequency_minutes > 0 
      ? (lang === 'en' ? `cooldown: ${alert.frequency_minutes}m` : `кулдаун: ${alert.frequency_minutes}м`) 
      : (lang === 'en' ? 'no cooldown' : 'без кулдауна');

    let trendLabel = '';
    if (alert.trend_mode === 'long') {
      trendLabel = ` <span class="trend-badge long-badge" style="color: #35d083; background: rgba(53, 208, 131, 0.1); padding: 2px 6px; border-radius: 4px; font-size: 10px; margin-left: 6px;">${lang === 'en' ? 'Long Crossover' : 'Long пересечение'}</span>`;
    } else if (alert.trend_mode === 'short') {
      trendLabel = ` <span class="trend-badge short-badge" style="color: #ef5e5e; background: rgba(239, 94, 94, 0.1); padding: 2px 6px; border-radius: 4px; font-size: 10px; margin-left: 6px;">${lang === 'en' ? 'Short Crossover' : 'Short пересечение'}</span>`;
    }

    if (isAuthenticated) {
      item.innerHTML = `
        <div class="alert-info">
          <span class="alert-title">${alert.name}${trendLabel}</span>
          <span class="alert-rule">${ruleString} (tf: ${tfString}, ${cooldownString})</span>
        </div>
        <div class="alert-actions">
          <label class="switch">
            <input type="checkbox" class="toggle-alert-active" data-id="${alert.id}" ${alert.active ? 'checked' : ''}/>
            <span class="slider"></span>
          </label>
          <button class="edit-alert-btn" data-id="${alert.id}" title="Edit Alert" type="button">✏️</button>
          <button class="delete-alert-btn" data-id="${alert.id}" title="Delete Alert" type="button">×</button>
        </div>
      `;

      item.querySelector('.slider').addEventListener('click', async (e) => {
        e.preventDefault();
        const checkbox = item.querySelector('.toggle-alert-active');
        checkbox.checked = !checkbox.checked;
        await toggleAlertActive(alert.id);
      });

      item.querySelector('.edit-alert-btn').addEventListener('click', () => {
        startEditAlert(alert);
      });

      item.querySelector('.delete-alert-btn').addEventListener('click', async () => {
        const confirmMsg = lang === 'en' 
          ? `Are you sure you want to delete alert "${alert.name}"?` 
          : `Вы уверены, что хотите удалить алерт "${alert.name}"?`;
        if (confirm(confirmMsg)) {
          await deleteAlert(alert.id);
        }
      });
    } else {
      // Read-only view
      const activeLabel = alert.active 
        ? (lang === 'en' ? 'Active' : 'Активен') 
        : (lang === 'en' ? 'Inactive' : 'Неактивен');
      item.innerHTML = `
        <div class="alert-info">
          <span class="alert-title">${alert.name}${trendLabel}</span>
          <span class="alert-rule">${ruleString} (tf: ${tfString}, ${cooldownString})</span>
        </div>
        <div class="alert-actions">
          <span style="font-size: 11px; color: var(--muted); background: rgba(38,49,55,0.4); padding: 2px 6px; border-radius: 4px;">${activeLabel}</span>
        </div>
      `;
    }

    container.appendChild(item);
  });
}

function formatStaticValue(field, val) {
  if (field === 'price') return `$${Number(val).toFixed(2)}`;
  if (field.includes('_avg_') || field.startsWith('avg_')) {
    return Number(val).toFixed(4);
  }
  if (field.startsWith('hl_') || field.startsWith('bybit_') || field.startsWith('twap') || field.startsWith('diff_')) {
    const num = Number(val);
    if (Math.abs(num) >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`;
    if (Math.abs(num) >= 1_000) return `$${(num / 1_000).toFixed(0)}k`;
    return `$${num}`;
  }
  return String(val);
}

async function toggleAlertActive(id) {
  try {
    const response = await fetch(`/api/alerts/${id}/toggle`, { method: 'POST' });
    if (!response.ok) throw new Error('Toggle failed');
    await loadAlerts();
  } catch (err) {
    console.error('Failed to toggle alert status:', err);
  }
}

async function deleteAlert(id) {
  try {
    const response = await fetch(`/api/alerts/${id}`, { method: 'DELETE' });
    if (!response.ok) throw new Error('Delete failed');
    await loadAlerts();
  } catch (err) {
    console.error('Failed to delete alert:', err);
  }
}

function startEditAlert(alert) {
  const submitBtn = alertElements.createAlertForm.querySelector('button[type="submit"]');
  alertElements.editAlertId.value = alert.id;
  alertElements.alertNameInput.value = alert.name;

  const container = alertElements.conditionsContainer;
  container.innerHTML = '';

  const expr = alert.expression;
  if (expr && expr.type === 'compound') {
    alertElements.logicalOperatorSelect.value = expr.logicalOperator || 'and';
    expr.conditions.forEach(cond => {
      const row = createConditionRow(cond);
      container.appendChild(row);
    });
  } else if (expr) {
    const row = createConditionRow(expr);
    container.appendChild(row);
  } else {
    const row = createConditionRow();
    container.appendChild(row);
  }

  updateLogicalOperatorVisibility();

  alertElements.trendModeSelect.value = alert.trend_mode || 'none';
  alertElements.alertTimeframeSelect.value = alert.timeframe || '1m';
  alertElements.frequencySelect.value = String(alert.frequency_minutes);

  const lang = localStorage.getItem('hype_twap_lang') || 'en';
  alertElements.tabCreateAlert.textContent = lang === 'en' ? '✏️ Edit Alert' : '✏️ Редактировать алерт';
  if (submitBtn) submitBtn.textContent = lang === 'en' ? 'Save Changes' : 'Сохранить изменения';

  // Navigate to Create tab
  alertElements.tabCreateAlert.click();
}

function clearEditAlertMode() {
  const submitBtn = alertElements.createAlertForm.querySelector('button[type="submit"]');
  alertElements.editAlertId.value = '';
  const lang = localStorage.getItem('hype_twap_lang') || 'en';
  alertElements.tabCreateAlert.textContent = lang === 'en' ? 'Create Alert' : 'Создать алерт';
  if (submitBtn) submitBtn.textContent = lang === 'en' ? 'Create Alert' : 'Создать алерт';
  resetAlertFormToDefault();
}

async function handleCreateAlert(e) {
  e.preventDefault();

  const name = alertElements.alertNameInput.value.trim();
  const trend_mode = alertElements.trendModeSelect.value;
  const timeframe = alertElements.alertTimeframeSelect.value;
  const frequency_minutes = Number(alertElements.frequencySelect.value);
  const editId = alertElements.editAlertId.value;
  const lang = localStorage.getItem('hype_twap_lang') || 'en';

  const container = alertElements.conditionsContainer;
  const rows = container.querySelectorAll('.condition-row');
  
  if (rows.length === 0) {
    showAlertFeedback(alertElements.formFeedback, lang === 'en' ? 'Please add at least one condition.' : 'Пожалуйста, добавьте хотя бы одно условие.', false);
    return;
  }

  let expression;

  if (rows.length === 1) {
    const row = rows[0];
    const field1 = row.querySelector('.left-metric-select').value;
    const operator = row.querySelector('.operator-select').value;
    const compareType = row.querySelector('.compare-type-select').value;
    
    expression = {
      field1,
      operator,
      compareType
    };

    if (compareType === 'value') {
      const val = Number(row.querySelector('.target-value-input').value);
      if (isNaN(val)) {
        showAlertFeedback(alertElements.formFeedback, lang === 'en' ? 'Please enter a valid numeric target value.' : 'Пожалуйста, введите корректное числовое значение.', false);
        return;
      }
      expression.value = val;
    } else {
      expression.field2 = row.querySelector('.right-metric-select').value;
    }
  } else {
    const logicalOperator = alertElements.logicalOperatorSelect.value;
    const conditions = [];

    for (const row of rows) {
      const field1 = row.querySelector('.left-metric-select').value;
      const operator = row.querySelector('.operator-select').value;
      const compareType = row.querySelector('.compare-type-select').value;
      
      const cond = {
        field1,
        operator,
        compareType
      };

      if (compareType === 'value') {
        const val = Number(row.querySelector('.target-value-input').value);
        if (isNaN(val)) {
          showAlertFeedback(alertElements.formFeedback, lang === 'en' ? 'Please enter a valid numeric target value for all conditions.' : 'Пожалуйста, введите корректное числовое значение для всех условий.', false);
          return;
        }
        cond.value = val;
      } else {
        cond.field2 = row.querySelector('.right-metric-select').value;
      }
      conditions.push(cond);
    }

    expression = {
      type: 'compound',
      logicalOperator,
      conditions
    };
  }

  try {
    const isEditing = !!editId;
    const url = isEditing ? `/api/alerts/${editId}` : '/api/alerts';
    const method = isEditing ? 'PUT' : 'POST';

    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, expression, frequency_minutes, trend_mode, timeframe })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to save alert.');

    showAlertFeedback(alertElements.formFeedback, isEditing ? (lang === 'en' ? 'Alert updated successfully!' : 'Алерт успешно обновлен!') : (lang === 'en' ? 'Alert created successfully!' : 'Алерт успешно создан!'), true);
    alertElements.createAlertForm.reset();
    clearEditAlertMode();

    // Switch tabs to alerts list
    alertElements.tabActiveAlerts.click();
    await loadAlerts();
  } catch (err) {
    showAlertFeedback(alertElements.formFeedback, err.message, false);
  }
}

async function logoutTelegram() {
  try {
    localStorage.setItem('tg_logged_out', 'true');
    const res = await fetch('/api/auth/logout', { method: 'POST' });
    if (res.ok) {
      await checkAuthState();
      window.location.reload();
    }
  } catch (err) {
    console.error('Logout failed:', err);
  }
}

async function checkAuthState() {
  try {
    const res = await fetch('/api/auth/telegram/config');
    const data = await res.json();
    const authBar = document.getElementById('authBar');
    const presetSaveBtn = document.getElementById('savePresetBtn');
    const presetDeleteBtn = document.getElementById('deletePresetBtn');
    const alertsTabs = document.getElementById('alertsTabs');
    const toggleSettingsBtn = document.getElementById('toggleSettingsBtn');
    const alertsAuthPlaceholder = document.getElementById('alertsAuthPlaceholder');

    if (data.user) {
      isAuthenticated = true;
      currentUser = data.user;
      localStorage.removeItem('tg_logged_out');
      if (authBar) {
        authBar.innerHTML = `<span>Logged in as <strong>${data.user.first_name}</strong></span> <button id="logoutBtn" class="logout-btn" type="button">Logout</button>`;
        document.getElementById('logoutBtn').addEventListener('click', logoutTelegram);
      }
      if (presetSaveBtn) {
        presetSaveBtn.disabled = false;
        presetSaveBtn.title = '';
      }
      if (presetDeleteBtn) {
        presetDeleteBtn.disabled = false;
        presetDeleteBtn.title = '';
      }
      if (alertsTabs) alertsTabs.classList.remove('hidden');
      if (toggleSettingsBtn) toggleSettingsBtn.classList.remove('hidden');
      if (alertsAuthPlaceholder) alertsAuthPlaceholder.classList.add('hidden');

      const tabAutoTrading = document.getElementById('tabAutoTrading');
      if (tabAutoTrading) {
        if (data.user.id && String(data.user.id) === '388735415') {
          tabAutoTrading.classList.remove('hidden');
        } else {
          tabAutoTrading.classList.add('hidden');
        }
      }
    } else {
      isAuthenticated = false;
      currentUser = null;
      if (authBar) {
        authBar.innerHTML = '';
      }
      if (presetSaveBtn) {
        presetSaveBtn.disabled = true;
        presetSaveBtn.title = '🔒 Log in with Telegram to save presets';
      }
      if (presetDeleteBtn) {
        presetDeleteBtn.disabled = true;
        presetDeleteBtn.title = '🔒 Log in with Telegram to delete presets';
      }
      if (alertsTabs) {
        alertsTabs.classList.add('hidden');
        alertElements.tabActiveAlerts.click();
      }
      if (toggleSettingsBtn) {
        toggleSettingsBtn.classList.remove('hidden');
      }
      if (alertsAuthPlaceholder) {
        alertsAuthPlaceholder.classList.remove('hidden');
      }
      const tabAutoTrading = document.getElementById('tabAutoTrading');
      if (tabAutoTrading) {
        tabAutoTrading.classList.add('hidden');
      }

      const loginContainer = document.getElementById('telegram-login-container');
      if (loginContainer) {
        if (data.botUsername) {
          if (localStorage.getItem('tg_logged_out') === 'true') {
            const lang = localStorage.getItem('hype_twap_lang') || 'en';
            const btnText = lang === 'en' ? 'Log in with Telegram' : 'Войти через Telegram';
            loginContainer.innerHTML = `<button id="customTgLoginBtn" class="action-btn" style="gap: 6px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block; vertical-align:middle;"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4Z"/></svg> <span style="vertical-align:middle;">${btnText}</span></button>`;
            document.getElementById('customTgLoginBtn').addEventListener('click', () => {
              const confirmMsg = lang === 'en'
                ? "Confirm login to the platform using Telegram?"
                : "Подтвердить вход на платформу с помощью Telegram?";
              if (confirm(confirmMsg)) {
                localStorage.removeItem('tg_logged_out');
                checkAuthState();
              }
            });
          } else {
            loginContainer.innerHTML = '';
            const script = document.createElement('script');
            script.async = true;
            script.src = 'https://telegram.org/js/telegram-widget.js?22';
            script.setAttribute('data-telegram-login', data.botUsername);
            script.setAttribute('data-size', 'medium');
            script.setAttribute('data-onauth', 'onTelegramAuth(user)');
            script.setAttribute('data-request-access', 'write');
            loginContainer.appendChild(script);
          }
        } else {
          loginContainer.innerHTML = '<span style="color: var(--red); font-size: 11px;">Telegram Bot token not configured on server. Set token in Settings or env.</span>';
        }

        const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        if (isLocalhost) {
          const devDiv = document.createElement('div');
          devDiv.style.marginTop = '10px';
          devDiv.innerHTML = `<button id="devLoginBypassBtn" class="action-btn" type="button" style="background: #2b3846; border-color: #3b4e63; color: #fff; font-size: 12px; padding: 6px 12px;">🔧 Dev Login (Bypass)</button>`;
          loginContainer.appendChild(devDiv);
          document.getElementById('devLoginBypassBtn').addEventListener('click', async () => {
            const res = await fetch('/api/auth/dev-login', { method: 'POST' });
            if (res.ok) {
              localStorage.removeItem('tg_logged_out');
              await checkAuthState();
              window.location.reload();
            } else {
              alert('Dev login failed');
            }
          });
        }
      }
    }
    await initializePresets();
    await loadAlerts();
  } catch (err) {
    console.error('Error checking auth state:', err);
  }
}

// Telegram global auth callback
window.onTelegramAuth = async function(user) {
  try {
    const res = await fetch('/api/auth/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(user)
    });
    if (res.ok) {
      localStorage.removeItem('tg_logged_out');
      await checkAuthState();
      window.location.reload();
    } else {
      const err = await res.json();
      alert(`Login failed: ${err.error || 'Unknown error'}`);
    }
  } catch (err) {
    console.error('Telegram authentication error:', err);
  }
};

function initAlertConfigurator() {
  // Attach UI Event Listeners
  alertElements.toggleSettingsBtn.addEventListener('click', () => {
    alertElements.settingsDrawer.classList.toggle('hidden');
  });

  alertElements.saveConfigBtn.addEventListener('click', saveTelegramConfig);
  alertElements.testBotBtn.addEventListener('click', testTelegramConnection);

  alertElements.tabActiveAlerts.addEventListener('click', () => {
    alertElements.tabActiveAlerts.classList.add('active');
    alertElements.tabCreateAlert.classList.remove('active');
    if (alertElements.tabBacktest) alertElements.tabBacktest.classList.remove('active');
    alertElements.tabContentList.classList.remove('hidden');
    alertElements.tabContentForm.classList.add('hidden');
    if (alertElements.tabContentBacktest) alertElements.tabContentBacktest.classList.add('hidden');
    clearEditAlertMode();
  });

  alertElements.tabCreateAlert.addEventListener('click', () => {
    alertElements.tabCreateAlert.classList.add('active');
    alertElements.tabActiveAlerts.classList.remove('active');
    if (alertElements.tabBacktest) alertElements.tabBacktest.classList.remove('active');
    alertElements.tabContentForm.classList.remove('hidden');
    alertElements.tabContentList.classList.add('hidden');
    if (alertElements.tabContentBacktest) alertElements.tabContentBacktest.classList.add('hidden');
  });

  alertElements.addConditionBtn.addEventListener('click', () => {
    const row = createConditionRow();
    alertElements.conditionsContainer.appendChild(row);
    updateLogicalOperatorVisibility();
  });

  alertElements.createAlertForm.addEventListener('submit', handleCreateAlert);

  resetAlertFormToDefault();
  checkAuthState().catch(console.error);
  
  // Initialize Backtester & Simulation panel
  initBacktestConfigurator();
  
  // Initialize Auto Trading panel
  initAutoTradingConfigurator();
}

// Startup Execution
function startup() {
  initPriceChart();
  initTwapChart();
  initializePresets().catch(console.error);
  initAlertConfigurator();
  
  // Attach language switcher event listeners
  const enBtn = document.getElementById('langBtnEn');
  const ruBtn = document.getElementById('langBtnRu');
  if (enBtn) enBtn.addEventListener('click', () => applyLanguage('en'));
  if (ruBtn) ruBtn.addEventListener('click', () => applyLanguage('ru'));

  // Load language preference
  const currentLang = localStorage.getItem('hype_twap_lang') || 'en';
  applyLanguage(currentLang);

  // Check and load shared preset if present
  const hasShared = checkAndLoadSharedPreset();
  if (!hasShared) {
    refreshChart().catch(console.error);
  }
  setInterval(() => refreshChart().catch(console.error), 30000);
}

// Translations and Language Switch Logic for Chart & Alerts page
const TRANSLATIONS = {
  en: {
    separateWindow: "Separate window",
    priceAndTwap: "Price and TWAP",
    buckets: "Buckets",
    addNewSubchart: "+ Add New Subchart",
    exchangeLabel: "Exchange:",
    presetsLabel: "Presets:",
    loadPreset: "Load Preset...",
    saveCurrent: "Save Current",
    delete: "Delete",
    priceStackedDepths: "HYPE Price & Stacked Depths",
    twapAverages: "TWAP Averages",
    spotPerp: "Spot + Perp",
    spot: "Spot",
    perp: "Perp",
    net1h: "Net 1H",
    net24h: "Net 24H",
    buy: "Buy",
    sell: "Sell",
    alertManager: "Telegram Alert Manager",
    botSettings: "⚙️ Bot Settings",
    botToken: "Telegram Bot Token",
    chatId: "Telegram Chat ID",
    saveSettings: "Save Settings",
    testConnection: "Test Connection",
    activeAlerts: "Active Alerts",
    createAlert: "Create Alert",
    noAlerts: "No alerts configured yet.",
    alertName: "Alert Name",
    alertConditions: "Alert Conditions",
    logicalGrouping: "Logical Grouping",
    andLabel: "AND (All conditions must be met)",
    orLabel: "OR (Any single condition can be met)",
    evaluationTimeframe: "Evaluation Timeframe",
    alertCrossoverMode: "Alert Crossover Mode",
    alertFrequency: "Alert Frequency (Cooldown)",
    createAlertBtn: "Create Alert",
    saveAlertBtn: "Save Alert",
    leftMetric: "Left Metric",
    operator: "Operator",
    compareWith: "Compare With",
    staticValue: "Static Value",
    anotherMetric: "Another Metric",
    targetValue: "Target Value",
    rightMetric: "Right Metric",
    addCondition: "➕ Add Condition",
    savePresetModalTitle: "Save Preset",
    presetNameLabel: "Preset Name:",
    includeTimeframe: "Include current timeframe",
    saveBtn: "Save",
    cancelBtn: "Cancel",
    sharePreset: "Share",
    linkCopied: "Link copied to clipboard!",
    profitFactorLabel: "Profit Factor",
    avgWinLossLabel: "Avg Win / Loss",
    maxWinLossLabel: "Max Win / Loss",
    winLossCountLabel: "Wins / Losses",
    
    authPlaceholder: "🔒 Log in with Telegram to configure bot settings and alerts:",
    dontSeeButton: "Don't see the button?",
    makeSure: "Make sure:",
    botTokenSaved: "The bot token is saved in ⚙️ Bot Settings.",
    domainMatches: "Your current domain matches the domain configured for the bot via @BotFather (using the /setdomain command).",
    
    connected: "Connected successfully!",
    settingsSaved: "Settings saved successfully!",
    testSuccess: "Test alert sent to Telegram!",
    testFailed: "Failed to send test alert. Check token and Chat ID.",
    errorOccurred: "An error occurred.",
    alertDeleted: "Alert deleted successfully.",
    alertCreated: "Alert created successfully.",
    alertUpdated: "Alert updated successfully.",
    backtestTab: "Backtest & Sim",
    backtestPeriod: "Trading Period (1-365 days)",
    backtestStartDate: "Start Date",
    backtestEndDate: "End Date",
    backtestDirection: "Signal Direction",
    backtestTradeAmount: "Sum per Trade (USD)",
    backtestTpMode: "Take Profit Mode",
    backtestSlMode: "Stop Loss Mode",
    backtestSlPercent: "Stop Loss (%)",
    backtestCloseAlert: "Exit Signal Alert",
    backtestTpClose: "Take Profit Exit Signal",
    backtestSlClose: "Stop Loss Exit Signal",
    sameAsSignal: "Same as Signal Alert",
    tradingResults: "Trading Results",
    backtestAlert: "Signal Alert",
    backtestMode: "Mode",
    tradingSim: "Trading Simulation",
    metricsAnalysis: "Metrics Analysis",
    numberLimitOrders: "Number of Limit Orders",
    takeProfitPercent: "Take Profit (%)",
    tpAnchorPrice: "TP Anchor Price",
    runSimulation: "Run Simulation",
    tradingSimResults: "Trading Simulation Results",
    totalTrades: "Total Trades",
    winRate: "Win Rate",
    totalNetProfit: "Total Net Profit",
    maxDrawdown: "Max Drawdown",
    metricsAnalysisResults: "Metrics Analysis Results (24h Window)",
    downsideDrawdownDeviation: "Downside Drawdown Deviation",
    upsideProfitRun: "Upside Profit Run",
    maximum: "Maximum",
    average: "Average",
    median: "Median",
    
    // Auto Trading translations
    autoTradeTab: "Auto Trading",
    autoTradeEnabledLabel: "Strategy Status (Active)",
    autoTradeExchangeLabel: "Exchange Source",
    autoTradeTestnetLabel: "Sandbox / Testnet",
    autoTradeWalletLabel: "Wallet Address",
    autoTradePrivateKeyLabel: "Private Key",
    autoTradeApiKeyLabel: "API Key",
    autoTradeApiSecretLabel: "API Secret",
    autoTradeAlertLabel: "Trigger Alert",
    autoTradeDirectionLabel: "Signal Direction",
    autoTradeOrderCountLabel: "Number of Limit Orders",
    autoTradeAmountLabel: "Sum per Trade (USD)",
    autoTradeTpModeLabel: "Take Profit Mode",
    autoTradeTpPercentLabel: "Take Profit (%)",
    autoTradeTpAnchorLabel: "TP Anchor Price",
    autoTradeTpCloseLabel: "Take Profit Exit Signal",
    autoTradeSlModeLabel: "Stop Loss Mode",
    autoTradeSlPercentLabel: "Stop Loss (%)",
    autoTradeSlCloseLabel: "Stop Loss Exit Signal",
    autoTradeSubaccountIndexLabel: "Subaccount Index",
    autoTradeUnfilledCancelMinutesLabel: "Cancel unfilled grid after, min",
    saveConfigStartBotLabel: "Save Strategy",
    configuredStrategies: "Configured Trading Strategies",
    createStrategy: "➕ Create Strategy",
    strategyName: "Strategy Name",
    btnCancel: "Cancel",
    configuredWallets: "Saved Wallets & API Keys",
    addWallet: "➕ Add Wallet",
    walletName: "Wallet Name",
    walletExchange: "Exchange Type",
    walletAddress: "Wallet Address",
    walletPrivateKey: "Private Key",
    walletApiKey: "API Key",
    walletApiSecret: "API Secret",
    btnSaveWallet: "Save Wallet",
    strategyWalletSelect: "Trading Wallet / API Credentials",
    titleAutoTradeStatusLabel: "Bot Status",
    titleAutoTradePositionsLabel: "Active Positions",
    thAutotradeAssetLabel: "Asset",
    thAutotradeSideLabel: "Dir",
    thAutotradeSizeLabel: "Size",
    thAutotradeEntryLabel: "Entry",
    thAutotradeMarkLabel: "Mark",
    thAutotradePnlLabel: "PnL",
    thAutotradeActionsLabel: "Action",
    tdAutotradeNoPositionsLabel: "No active positions.",
    titleAutoTradeLogsLabel: "Recent Trade Logs",
    titleAutoTradeHistoryLabel: "Recent Trade History",
    pAutotradeNoHistoryLabel: "No completed trades yet."
  },
  ru: {
    separateWindow: "Отдельное окно",
    priceAndTwap: "Цена и TWAP",
    buckets: "Бакеты",
    addNewSubchart: "+ Добавить подокно",
    exchangeLabel: "Биржа:",
    presetsLabel: "Пресеты:",
    loadPreset: "Загрузить пресет...",
    saveCurrent: "Сохранить",
    delete: "Удалить",
    priceStackedDepths: "Цена HYPE и глубина стакана",
    twapAverages: "Средние значения TWAPs",
    spotPerp: "Спот + Перп",
    spot: "Спот",
    perp: "Перп",
    net1h: "Чистый 1Ч",
    net24h: "Чистый 24Ч",
    buy: "Покупка",
    sell: "Продажа",
    alertManager: "Менеджер Telegram уведомлений",
    botSettings: "⚙️ Настройки бота",
    botToken: "Токен Telegram бота",
    chatId: "Telegram Chat ID",
    saveSettings: "Сохранить настройки",
    testConnection: "Проверить соединение",
    activeAlerts: "Активные алерты",
    createAlert: "Создать алерт",
    noAlerts: "Алерты не настроены.",
    alertName: "Название алерта",
    alertConditions: "Условия алерта",
    logicalGrouping: "Логическая группировка",
    andLabel: "И (Все условия должны выполняться)",
    orLabel: "ИЛИ (Любое из условий должно выполняться)",
    evaluationTimeframe: "Таймфрейм проверки",
    alertCrossoverMode: "Режим пересечения алерта",
    alertFrequency: "Частота алерта (кулдаун)",
    createAlertBtn: "Создать алерт",
    saveAlertBtn: "Сохранить изменения",
    leftMetric: "Левая метрика",
    operator: "Оператор",
    compareWith: "Сравнить с",
    staticValue: "Статическое значение",
    anotherMetric: "Другая метрика",
    targetValue: "Целевое значение",
    rightMetric: "Правая метрика",
    addCondition: "➕ Добавить условие",
    savePresetModalTitle: "Сохранить пресет",
    presetNameLabel: "Название пресета:",
    includeTimeframe: "Включить текущий таймфрейм",
    saveBtn: "Сохранить",
    cancelBtn: "Отмена",
    sharePreset: "Поделиться",
    linkCopied: "Ссылка скопирована в буфер обмена!",
    profitFactorLabel: "Профит-фактор",
    avgWinLossLabel: "Ср. Прибыль / Убыток",
    maxWinLossLabel: "Макс. Прибыль / Убыток",
    winLossCountLabel: "Побед / Поражений",
    
    authPlaceholder: "🔒 Войдите через Telegram для настройки бота и алертов:",
    dontSeeButton: "Не видите кнопку?",
    makeSure: "Убедитесь, что:",
    botTokenSaved: "Токен бота сохранен в ⚙️ Настройках бота.",
    domainMatches: "Текущий домен совпадает с доменов бота в @BotFather (команда /setdomain).",

    connected: "Соединение успешно установлено!",
    settingsSaved: "Настройки успешно сохранены!",
    testSuccess: "Тестовое уведомление отправлено в Telegram!",
    testFailed: "Не удалось отправить тестовое уведомление. Проверьте токен и Chat ID.",
    errorOccurred: "Произошла ошибка.",
    alertDeleted: "Алерт успешно удален.",
    alertCreated: "Алерт успешно создан.",
    alertUpdated: "Алерт успешно обновлен.",
    backtestTab: "Бэктест и Тест",
    backtestPeriod: "Период торговли (1-365 дней)",
    backtestStartDate: "Дата начала",
    backtestEndDate: "Дата окончания",
    backtestDirection: "Направление сигнала",
    backtestTradeAmount: "Сумма на сделку (USD)",
    backtestTpMode: "Режим Тейк Профита",
    backtestSlMode: "Режим Стоп Лосса",
    backtestSlPercent: "Стоп Лосс (%)",
    backtestCloseAlert: "Сигнал для закрытия",
    backtestTpClose: "Сигнал для закрития по Тейк Профиту",
    backtestSlClose: "Сигнал для закрития по Стоп Лоссу",
    sameAsSignal: "По умолчанию (текущий)",
    tradingResults: "Результаты торговли",
    backtestAlert: "Сигнальное оповещение",
    backtestMode: "Режим",
    tradingSim: "Симуляция торговли",
    metricsAnalysis: "Тест метрики",
    numberLimitOrders: "Количество лимитных ордеров",
    takeProfitPercent: "Тейк профит (%)",
    tpAnchorPrice: "База для Тейк Профита",
    runSimulation: "Запустить тест",
    tradingSimResults: "Результаты симуляции торговли",
    totalTrades: "Всего сделок",
    winRate: "Процент побед",
    totalNetProfit: "Чистая прибыль",
    maxDrawdown: "Макс. просадка",
    metricsAnalysisResults: "Результаты теста метрики (24ч окно)",
    downsideDrawdownDeviation: "Снижение цены вниз после сигнала",
    upsideProfitRun: "Рост цены вверх после сигнала",
    maximum: "Максимум",
    average: "Среднее",
    median: "Медиана",
    
    // Auto Trading translations
    autoTradeTab: "Авто-торговля",
    autoTradeEnabledLabel: "Статус стратегии (Активна)",
    autoTradeExchangeLabel: "Биржа",
    autoTradeTestnetLabel: "Песочница / Тестнет",
    autoTradeWalletLabel: "Адрес кошелька",
    autoTradePrivateKeyLabel: "Приватный ключ",
    autoTradeApiKeyLabel: "API Ключ",
    autoTradeApiSecretLabel: "API Секрет",
    autoTradeAlertLabel: "Сигнальный алерт",
    autoTradeDirectionLabel: "Направление сигнала",
    autoTradeOrderCountLabel: "Количество лимитных ордеров",
    autoTradeAmountLabel: "Сумма на сделку (USD)",
    autoTradeTpModeLabel: "Режим Тейк Профита",
    autoTradeTpPercentLabel: "Тейк профит (%)",
    autoTradeTpAnchorLabel: "База для Тейк Профита",
    autoTradeTpCloseLabel: "Сигнал для закрытия по Тейк Профиту",
    autoTradeSlModeLabel: "Режим Стоп Лосса",
    autoTradeSlPercentLabel: "Стоп Лосс (%)",
    autoTradeSlCloseLabel: "Сигнал для закрытия по Стоп Лоссу",
    autoTradeSubaccountIndexLabel: "Индекс субаккаунта",
    autoTradeUnfilledCancelMinutesLabel: "Отменить незаполненную сетку через, мин",
    saveConfigStartBotLabel: "Сохранить стратегию",
    configuredStrategies: "Настроенные торговые стратегии",
    createStrategy: "➕ Создать стратегию",
    strategyName: "Название стратегии",
    btnCancel: "Отмена",
    configuredWallets: "Сохраненные кошельки и API ключи",
    addWallet: "➕ Добавить кошелек",
    walletName: "Название кошелька",
    walletExchange: "Тип биржи",
    walletAddress: "Адрес кошелька",
    walletPrivateKey: "Приватный ключ",
    walletApiKey: "API Ключ",
    walletApiSecret: "API Секрет",
    btnSaveWallet: "Сохранить кошелек",
    strategyWalletSelect: "Торговый кошелек / API ключи",
    titleAutoTradeStatusLabel: "Статус бота",
    titleAutoTradePositionsLabel: "Активные позиции",
    thAutotradeAssetLabel: "Актив",
    thAutotradeSideLabel: "Направление",
    thAutotradeSizeLabel: "Размер",
    thAutotradeEntryLabel: "Вход",
    thAutotradeMarkLabel: "Маркировка",
    thAutotradePnlLabel: "Прибыль",
    thAutotradeActionsLabel: "Действие",
    tdAutotradeNoPositionsLabel: "Нет активных позиций.",
    titleAutoTradeLogsLabel: "Логи торговли",
    titleAutoTradeHistoryLabel: "История сделок",
    pAutotradeNoHistoryLabel: "Нет совершенных сделок."
  }
};

const TIMEFRAME_LABELS = {
  en: {
    "1m": "1m (1 Minute)",
    "5m": "5m (5 Minutes)",
    "15m": "15m (15 Minutes)",
    "1h": "1h (1 Hour)",
    "4h": "4h (4 Hours)",
    "1d": "1d (1 Day)"
  },
  ru: {
    "1m": "1м (1 минута)",
    "5m": "5м (5 минут)",
    "15m": "15м (15 минут)",
    "1h": "1ч (1 час)",
    "4h": "4ч (4 часа)",
    "1d": "1д (1 день)"
  }
};

const TREND_MODE_LABELS = {
  en: {
    "none": "Standard (Static Threshold Alert)",
    "long": "Long Crossover (Triggers only if crossover price is HIGHER than last crossover)",
    "short": "Short Crossover (Triggers only if crossover price is LOWER than last crossover)"
  },
  ru: {
    "none": "Стандартный (алерт по статическому порогу)",
    "long": "Long пересечение (срабатывает, если цена пересечения выше предыдущей)",
    "short": "Short пересечение (срабатывает, если цена пересечения ниже предыдущей)"
  }
};

const FREQUENCY_LABELS = {
  en: {
    "0": "Every Minute (No Cooldown)",
    "5": "Every 5 Minutes",
    "15": "Every 15 Minutes",
    "30": "Every 30 Minutes",
    "60": "Every 1 Hour",
    "240": "Every 4 Hours",
    "1440": "Once a Day (24 Hours)"
  },
  ru: {
    "0": "Каждую минуту (без кулдауна)",
    "5": "Каждые 5 минут",
    "15": "Каждые 15 минут",
    "30": "Каждые 30 минут",
    "60": "Каждый час",
    "240": "Каждые 4 часа",
    "1440": "Раз в день (24 часа)"
  }
};

let cachedAlerts = [];

function translateExistingConditionRows(lang) {
  const container = alertElements.conditionsContainer;
  if (!container) return;
  const rows = container.querySelectorAll('.condition-row');
  rows.forEach(row => {
    const t = TRANSLATIONS[lang];
    const lblLeftMetric = row.querySelector('.lbl-left-metric');
    if (lblLeftMetric) lblLeftMetric.textContent = t.leftMetric;
    const lblOperator = row.querySelector('.lbl-operator');
    if (lblOperator) lblOperator.textContent = t.operator;
    const lblCompareWith = row.querySelector('.lbl-compare-with');
    if (lblCompareWith) lblCompareWith.textContent = t.compareWith;
    const lblTargetValue = row.querySelector('.lbl-target-value');
    if (lblTargetValue) lblTargetValue.textContent = t.targetValue;
    const lblRightMetric = row.querySelector('.lbl-right-metric');
    if (lblRightMetric) lblRightMetric.textContent = t.rightMetric;

    const compareSelect = row.querySelector('.compare-type-select');
    if (compareSelect) {
      compareSelect.options[0].textContent = t.staticValue;
      compareSelect.options[1].textContent = t.anotherMetric;
    }

    const targetInput = row.querySelector('.target-value-input');
    if (targetInput) {
      targetInput.placeholder = lang === 'en' ? 'e.g. 30000000 (for $30M)' : 'напр. 30000000 (для $30M)';
    }

    const leftSelect = row.querySelector('.left-metric-select');
    const leftVal = leftSelect ? leftSelect.value : null;
    const rightSelect = row.querySelector('.right-metric-select');
    const rightVal = rightSelect ? rightSelect.value : null;

    if (leftSelect) {
      populateMetricSelect(leftSelect, lang);
      if (leftVal) leftSelect.value = leftVal;
    }
    if (rightSelect) {
      populateMetricSelect(rightSelect, lang);
      if (rightVal) rightSelect.value = rightVal;
    }
  });
}

function updateAuthPlaceholderTranslations(lang) {
  const container = document.getElementById('alertsAuthPlaceholder');
  if (!container) return;
  const t = TRANSLATIONS[lang];
  
  const span = container.querySelector('.auth-info-row span');
  if (span) span.textContent = t.authPlaceholder;
  
  const descDiv = container.querySelector('div[style*="font-size: 11px"]');
  if (descDiv) {
    descDiv.innerHTML = `
      <strong>ℹ️ ${t.dontSeeButton}</strong> ${t.makeSure}
      <ul style="text-align: left; margin: 4px 0 0 16px; padding: 0;">
        <li>${t.botTokenSaved}</li>
        <li>${t.domainMatches}</li>
      </ul>
    `;
  }

  // Dynamic update for custom login button
  const customTgLoginBtn = document.getElementById('customTgLoginBtn');
  if (customTgLoginBtn) {
    const btnText = lang === 'en' ? 'Log in with Telegram' : 'Войти через Telegram';
    customTgLoginBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block; vertical-align:middle;"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4Z"/></svg> <span style="vertical-align:middle;">${btnText}</span>`;
  }
}

function applyLanguage(lang) {
  localStorage.setItem('hype_twap_lang', lang);
  
  const enBtn = document.getElementById('langBtnEn');
  const ruBtn = document.getElementById('langBtnRu');
  if (enBtn) enBtn.classList.toggle('active', lang === 'en');
  if (ruBtn) ruBtn.classList.toggle('active', lang === 'ru');

  const t = TRANSLATIONS[lang] || TRANSLATIONS.en;

  // Header and controls
  const lblSeparateWindow = document.getElementById('lblSeparateWindow');
  if (lblSeparateWindow) lblSeparateWindow.textContent = t.separateWindow;
  const lblPriceAndTwap = document.getElementById('lblPriceAndTwap');
  if (lblPriceAndTwap) lblPriceAndTwap.textContent = t.priceAndTwap;
  const lblBuckets = document.getElementById('lblBuckets');
  if (lblBuckets) lblBuckets.textContent = t.buckets;
  const addNewPanelBtn = document.getElementById('addNewPanelBtn');
  if (addNewPanelBtn) addNewPanelBtn.textContent = t.addNewSubchart;

  // Exchange and Presets
  const exchangeLabel = document.querySelector('.depth-controls-panel .control-group:nth-child(2) .label');
  if (exchangeLabel) exchangeLabel.textContent = t.exchangeLabel;
  
  const exchangeSelect = document.getElementById('exchangeSourceSelect');
  if (exchangeSelect) {
    exchangeSelect.options[0].textContent = lang === 'en' ? 'Bybit + HL (Combined)' : 'Bybit + HL (Совмещенно)';
    exchangeSelect.options[1].textContent = lang === 'en' ? 'Bybit + HL (Separate)' : 'Bybit + HL (Раздельно)';
    exchangeSelect.options[2].textContent = lang === 'en' ? 'Bybit Only' : 'Только Bybit';
    exchangeSelect.options[3].textContent = lang === 'en' ? 'Hyperliquid Only' : 'Только Hyperliquid';
  }

  const presetsLabel = document.querySelector('.depth-controls-panel .control-group:nth-child(3) .label');
  if (presetsLabel) presetsLabel.textContent = t.presetsLabel;

  const presetSelect = document.getElementById('presetSelect');
  if (presetSelect && presetSelect.options[0]) {
    presetSelect.options[0].textContent = t.loadPreset;
  }
  const savePresetBtn = document.getElementById('savePresetBtn');
  if (savePresetBtn) savePresetBtn.textContent = t.saveCurrent;
  const deletePresetBtn = document.getElementById('deletePresetBtn');
  if (deletePresetBtn) deletePresetBtn.textContent = t.delete;
  const sharePresetBtn = document.getElementById('sharePresetBtn');
  if (sharePresetBtn) sharePresetBtn.textContent = t.sharePreset;

  // Chart headings
  const mainChartTitle = document.querySelector('#mainChartPanel .panel-head .label');
  if (mainChartTitle) mainChartTitle.textContent = t.priceStackedDepths;

  const twapChartTitle = document.querySelector('.twap-panel .panel-head .label');
  if (twapChartTitle) twapChartTitle.textContent = t.twapAverages;

  // TWAP Modes buttons
  const twapModes = document.querySelectorAll('.twap-mode-toggle button');
  if (twapModes.length >= 3) {
    twapModes[0].textContent = t.spotPerp;
    twapModes[1].textContent = t.spot;
    twapModes[2].textContent = t.perp;
  }

  // TWAP chart toggles
  const toggles = document.querySelectorAll('.metric-toggles label');
  const metricLabels = [t.net1h, t.net24h, t.buy, t.sell];
  toggles.forEach((label, idx) => {
    const input = label.querySelector('input');
    label.innerHTML = '';
    label.appendChild(input);
    label.appendChild(document.createTextNode(' ' + metricLabels[idx]));
  });

  // Alert Manager Header
  const alertManagerHeader = document.querySelector('.alerts-header h2');
  if (alertManagerHeader) alertManagerHeader.textContent = t.alertManager;

  const toggleSettingsBtn = document.getElementById('toggleSettingsBtn');
  if (toggleSettingsBtn) toggleSettingsBtn.textContent = '⚙️ ' + (lang === 'en' ? 'Bot Settings' : 'Настройки бота');

  const botTokenLabel = document.querySelector('label[for="tgTokenInput"]');
  if (botTokenLabel) botTokenLabel.textContent = t.botToken;

  const chatIdLabel = document.querySelector('label[for="tgChatIdInput"]');
  if (chatIdLabel) chatIdLabel.textContent = t.chatId;

  const saveConfigBtn = document.getElementById('saveConfigBtn');
  if (saveConfigBtn) saveConfigBtn.textContent = t.saveSettings;
  const testBotBtn = document.getElementById('testBotBtn');
  if (testBotBtn) testBotBtn.textContent = t.testConnection;

  // Tabs
  const activeAlertsTab = document.getElementById('tabActiveAlerts');
  if (activeAlertsTab) {
    const countSpan = document.getElementById('alertsCount');
    const count = countSpan ? countSpan.textContent : '0';
    activeAlertsTab.innerHTML = `${lang === 'en' ? 'Active Alerts' : 'Активные алерты'} (<span id="alertsCount">${count}</span>)`;
  }
  const createAlertTab = document.getElementById('tabCreateAlert');
  if (createAlertTab) {
    const isEdit = document.getElementById('editAlertId').value !== '';
    createAlertTab.textContent = isEdit ? (lang === 'en' ? '✏️ Edit Alert' : '✏️ Редактировать алерт') : t.createAlert;
  }

  // Create alert form static labels
  const formLabels = document.querySelectorAll('#createAlertForm .form-group > label');
  if (formLabels.length >= 2) {
    formLabels[0].textContent = t.alertName;
    formLabels[1].textContent = t.alertConditions;
  }
  const logicalOpLabel = document.querySelector('label[for="logicalOperatorSelect"]');
  if (logicalOpLabel) logicalOpLabel.textContent = t.logicalGrouping;

  const logicalOpSelect = document.getElementById('logicalOperatorSelect');
  if (logicalOpSelect) {
    logicalOpSelect.options[0].textContent = t.andLabel;
    logicalOpSelect.options[1].textContent = t.orLabel;
  }

  const addConditionBtn = document.getElementById('addConditionBtn');
  if (addConditionBtn) addConditionBtn.textContent = t.addCondition;

  const evaluationTimeframeLabel = document.querySelector('label[for="alertTimeframeSelect"]');
  if (evaluationTimeframeLabel) evaluationTimeframeLabel.textContent = t.evaluationTimeframe;

  const trendModeSelectLabel = document.querySelector('label[for="trendModeSelect"]');
  if (trendModeSelectLabel) trendModeSelectLabel.textContent = t.alertCrossoverMode;

  const frequencySelectLabel = document.querySelector('label[for="frequencySelect"]');
  if (frequencySelectLabel) frequencySelectLabel.textContent = t.alertFrequency;

  // Form submit button
  const formSubmitBtn = document.querySelector('#createAlertForm button[type="submit"]');
  if (formSubmitBtn) {
    const isEdit = document.getElementById('editAlertId').value !== '';
    formSubmitBtn.textContent = isEdit ? t.saveAlertBtn : t.createAlertBtn;
  }

  // Timeframe and other options
  const tfSelect = document.getElementById('alertTimeframeSelect');
  if (tfSelect) {
    [...tfSelect.options].forEach(opt => {
      opt.textContent = TIMEFRAME_LABELS[lang][opt.value];
    });
  }

  const trendSelect = document.getElementById('trendModeSelect');
  if (trendSelect) {
    [...trendSelect.options].forEach(opt => {
      opt.textContent = TREND_MODE_LABELS[lang][opt.value];
    });
  }

  const freqSelect = document.getElementById('frequencySelect');
  if (freqSelect) {
    [...freqSelect.options].forEach(opt => {
      opt.textContent = FREQUENCY_LABELS[lang][opt.value];
    });
  }

  // Update existing conditions inside builder
  translateExistingConditionRows(lang);

  // Update Auth placeholder info
  updateAuthPlaceholderTranslations(lang);

  // Save Preset Modal
  const presetModalTitle = document.querySelector('#savePresetModal h2');
  if (presetModalTitle) presetModalTitle.textContent = t.savePresetModalTitle;

  const presetNameLabel = document.querySelector('label[for="presetNameInput"]');
  if (presetNameLabel) presetNameLabel.textContent = t.presetNameLabel;

  const saveTimeframeCheckboxLabel = document.querySelector('#savePresetModal .checkbox-group label');
  if (saveTimeframeCheckboxLabel) {
    const checkbox = document.getElementById('saveTimeframeCheckbox');
    saveTimeframeCheckboxLabel.innerHTML = '';
    saveTimeframeCheckboxLabel.appendChild(checkbox);
    saveTimeframeCheckboxLabel.appendChild(document.createTextNode(' ' + t.includeTimeframe));
  }

  const confirmSavePresetBtn = document.getElementById('confirmSavePresetBtn');
  if (confirmSavePresetBtn) confirmSavePresetBtn.textContent = t.saveBtn;
  const cancelSavePresetBtn = document.getElementById('cancelSavePresetBtn');
  if (cancelSavePresetBtn) cancelSavePresetBtn.textContent = t.cancelBtn;

  // Backtest translations
  const tabBacktest = document.getElementById('tabBacktest');
  if (tabBacktest) tabBacktest.textContent = t.backtestTab;
  
  const lblBacktestStartDate = document.getElementById('lblBacktestStartDate');
  if (lblBacktestStartDate) lblBacktestStartDate.textContent = t.backtestStartDate;
  
  const lblBacktestEndDate = document.getElementById('lblBacktestEndDate');
  if (lblBacktestEndDate) lblBacktestEndDate.textContent = t.backtestEndDate;
  
  const lblBacktestAlert = document.getElementById('lblBacktestAlert');
  if (lblBacktestAlert) lblBacktestAlert.textContent = t.backtestAlert;
  
  const lblBacktestDirection = document.getElementById('lblBacktestDirection');
  if (lblBacktestDirection) lblBacktestDirection.textContent = t.backtestDirection;
  
  const backtestDirectionSelect = document.getElementById('backtestDirectionSelect');
  if (backtestDirectionSelect) {
    backtestDirectionSelect.options[0].textContent = lang === 'en' ? 'Auto (From Crossover)' : 'Авто (из пересечения)';
    backtestDirectionSelect.options[1].textContent = lang === 'en' ? 'Long (Crossover Only)' : 'Лонг (только пересечение)';
    backtestDirectionSelect.options[2].textContent = lang === 'en' ? 'Short (Crossover Only)' : 'Шорт (только пересечение)';
    backtestDirectionSelect.options[3].textContent = lang === 'en' ? 'Trend Long (Price Crossover)' : 'Трендовый Лонг (с ростом цены)';
    backtestDirectionSelect.options[4].textContent = lang === 'en' ? 'Trend Short (Price Crossover)' : 'Трендовый Шорт (с падением цены)';
  }
  
  const lblBacktestTradeAmount = document.getElementById('lblBacktestTradeAmount');
  if (lblBacktestTradeAmount) lblBacktestTradeAmount.textContent = t.backtestTradeAmount;
  
  const lblBacktestMode = document.getElementById('lblBacktestMode');
  if (lblBacktestMode) lblBacktestMode.textContent = t.backtestMode;
  
  const backtestModeSelect = document.getElementById('backtestModeSelect');
  if (backtestModeSelect) {
    backtestModeSelect.options[0].textContent = t.tradingSim;
    backtestModeSelect.options[1].textContent = t.metricsAnalysis;
  }
  
  const lblBacktestOrderCount = document.getElementById('lblBacktestOrderCount');
  if (lblBacktestOrderCount) lblBacktestOrderCount.textContent = t.numberLimitOrders;
  
  // Leg titles
  const legRows = document.querySelectorAll('.grid-leg-row');
  legRows.forEach(row => {
    const legNum = row.dataset.leg;
    const offsetLbl = row.querySelector(`.lblLegOffset${legNum}`);
    if (offsetLbl) offsetLbl.textContent = lang === 'en' ? `Order ${legNum} Offset (%)` : `Ордер ${legNum} Отклонение (%)`;
    const amountLbl = row.querySelector(`.lblLegAmount${legNum}`);
    if (amountLbl) amountLbl.textContent = lang === 'en' ? `Order ${legNum} Amount (USD)` : `Ордер ${legNum} Сумма (USD)`;
  });
  
  const lblBacktestTpMode = document.getElementById('lblBacktestTpMode');
  if (lblBacktestTpMode) lblBacktestTpMode.textContent = t.backtestTpMode;
  
  const backtestTpMode = document.getElementById('backtestTpMode');
  if (backtestTpMode) {
    backtestTpMode.options[0].textContent = lang === 'en' ? 'Percent Offset' : 'Процентное отклонение';
    backtestTpMode.options[1].textContent = lang === 'en' ? 'Metric Crossover (Next Signal)' : 'Пересечение показателей (след. сигнал)';
  }
  
  const lblBacktestTpPercent = document.getElementById('lblBacktestTpPercent');
  if (lblBacktestTpPercent) lblBacktestTpPercent.textContent = t.takeProfitPercent;
  
  const lblBacktestTpAnchor = document.getElementById('lblBacktestTpAnchor');
  if (lblBacktestTpAnchor) lblBacktestTpAnchor.textContent = t.tpAnchorPrice;
  
  const backtestTpAnchor = document.getElementById('backtestTpAnchor');
  if (backtestTpAnchor) {
    backtestTpAnchor.options[0].textContent = lang === 'en' ? 'Average Entry Price' : 'Средняя цена входа';
    backtestTpAnchor.options[1].textContent = lang === 'en' ? 'Order 1 Price' : 'Цена 1-го ордера';
    backtestTpAnchor.options[2].textContent = lang === 'en' ? 'Order 2 Price' : 'Цена 2-го ордера';
    backtestTpAnchor.options[3].textContent = lang === 'en' ? 'Order 3 Price' : 'Цена 3-го ордера';
  }
  
  const lblBacktestSlMode = document.getElementById('lblBacktestSlMode');
  if (lblBacktestSlMode) lblBacktestSlMode.textContent = t.backtestSlMode;
  
  const backtestSlMode = document.getElementById('backtestSlMode');
  if (backtestSlMode) {
    backtestSlMode.options[0].textContent = lang === 'en' ? 'None' : 'Нет';
    backtestSlMode.options[1].textContent = lang === 'en' ? 'Percent Offset' : 'Процентное отклонение';
    backtestSlMode.options[2].textContent = lang === 'en' ? 'Metric Crossover (Next Signal)' : 'Пересечение показателей (след. сигнал)';
  }
  
  const lblBacktestSlPercent = document.getElementById('lblBacktestSlPercent');
  if (lblBacktestSlPercent) lblBacktestSlPercent.textContent = t.backtestSlPercent;
  
  const lblBacktestTpClose = document.getElementById('lblBacktestTpClose');
  if (lblBacktestTpClose) lblBacktestTpClose.textContent = t.backtestTpClose;
  
  const lblBacktestSlClose = document.getElementById('lblBacktestSlClose');
  if (lblBacktestSlClose) lblBacktestSlClose.textContent = t.backtestSlClose;

  populateBacktestCloseAlertSelect();
  
  const btnRunBacktest = document.getElementById('btnRunBacktest');
  if (btnRunBacktest) btnRunBacktest.textContent = t.runSimulation;
  
  const titleTradingResults = document.getElementById('titleTradingResults');
  if (titleTradingResults) titleTradingResults.textContent = t.tradingSimResults;
  
  const lblStatTotalTrades = document.getElementById('lblStatTotalTrades');
  if (lblStatTotalTrades) lblStatTotalTrades.textContent = t.totalTrades;
  
  const lblStatWinRate = document.getElementById('lblStatWinRate');
  if (lblStatWinRate) lblStatWinRate.textContent = t.winRate;
  
  const lblStatNetProfit = document.getElementById('lblStatNetProfit');
  if (lblStatNetProfit) lblStatNetProfit.textContent = t.totalNetProfit;
  
  const lblStatMaxDrawdown = document.getElementById('lblStatMaxDrawdown');
  if (lblStatMaxDrawdown) lblStatMaxDrawdown.textContent = t.maxDrawdown;

  const lblStatProfitFactor = document.getElementById('lblStatProfitFactor');
  if (lblStatProfitFactor) lblStatProfitFactor.textContent = t.profitFactorLabel;
  const lblStatAvgWinLoss = document.getElementById('lblStatAvgWinLoss');
  if (lblStatAvgWinLoss) lblStatAvgWinLoss.textContent = t.avgWinLossLabel;
  const lblStatMaxWinLoss = document.getElementById('lblStatMaxWinLoss');
  if (lblStatMaxWinLoss) lblStatMaxWinLoss.textContent = t.maxWinLossLabel;
  const lblStatWinLossCount = document.getElementById('lblStatWinLossCount');
  if (lblStatWinLossCount) lblStatWinLossCount.textContent = t.winLossCountLabel;
  
  const titleMetricsResults = document.getElementById('titleMetricsResults');
  if (titleMetricsResults) titleMetricsResults.textContent = t.metricsAnalysisResults;
  
  const titleDrawdownSection = document.getElementById('titleDrawdownSection');
  if (titleDrawdownSection) titleDrawdownSection.textContent = t.downsideDrawdownDeviation;
  
  const titleUpsideSection = document.getElementById('titleUpsideSection');
  if (titleUpsideSection) titleUpsideSection.textContent = t.upsideProfitRun;
  
  const drawMaxLbl = document.getElementById('lblDrawdownMax');
  if (drawMaxLbl) drawMaxLbl.textContent = t.maximum;
  const drawAvgLbl = document.getElementById('lblDrawdownAvg');
  if (drawAvgLbl) drawAvgLbl.textContent = t.average;
  const drawMedLbl = document.getElementById('lblDrawdownMed');
  if (drawMedLbl) drawMedLbl.textContent = t.median;
  
  const upMaxLbl = document.getElementById('lblUpsideMax');
  if (upMaxLbl) upMaxLbl.textContent = t.maximum;
  const upAvgLbl = document.getElementById('lblUpsideAvg');
  if (upAvgLbl) upAvgLbl.textContent = t.average;
  const upMedLbl = document.getElementById('lblUpsideMed');
  if (upMedLbl) upMedLbl.textContent = t.median;

  const titleMetricsTradingSection = document.getElementById('titleMetricsTradingSection');
  if (titleMetricsTradingSection) titleMetricsTradingSection.textContent = t.tradingResults;
  
  const lblMetricsStatTotalTrades = document.getElementById('lblMetricsStatTotalTrades');
  if (lblMetricsStatTotalTrades) lblMetricsStatTotalTrades.textContent = t.totalTrades;
  
  const lblMetricsStatWinRate = document.getElementById('lblMetricsStatWinRate');
  if (lblMetricsStatWinRate) lblMetricsStatWinRate.textContent = t.winRate;
  
  const lblMetricsStatNetProfit = document.getElementById('lblMetricsStatNetProfit');
  if (lblMetricsStatNetProfit) lblMetricsStatNetProfit.textContent = t.totalNetProfit;

  const lblMetricsStatProfitFactor = document.getElementById('lblMetricsStatProfitFactor');
  if (lblMetricsStatProfitFactor) lblMetricsStatProfitFactor.textContent = t.profitFactorLabel;
  const lblMetricsStatAvgWinLoss = document.getElementById('lblMetricsStatAvgWinLoss');
  if (lblMetricsStatAvgWinLoss) lblMetricsStatAvgWinLoss.textContent = t.avgWinLossLabel;
  const lblMetricsStatMaxWinLoss = document.getElementById('lblMetricsStatMaxWinLoss');
  if (lblMetricsStatMaxWinLoss) lblMetricsStatMaxWinLoss.textContent = t.maxWinLossLabel;
  const lblMetricsStatWinLossCount = document.getElementById('lblMetricsStatWinLossCount');
  if (lblMetricsStatWinLossCount) lblMetricsStatWinLossCount.textContent = t.winLossCountLabel;

  // Auto Trading tab translations
  const tabAutoTrading = document.getElementById('tabAutoTrading');
  if (tabAutoTrading) tabAutoTrading.textContent = t.autoTradeTab;

  const lblAutoTradeEnabled = document.getElementById('lblAutoTradeEnabled');
  if (lblAutoTradeEnabled) lblAutoTradeEnabled.textContent = t.autoTradeEnabledLabel;

  const lblAutoTradeExchange = document.getElementById('lblAutoTradeExchange');
  if (lblAutoTradeExchange) lblAutoTradeExchange.textContent = t.autoTradeExchangeLabel;

  const lblAutoTradeSubaccountIndex = document.getElementById('lblAutoTradeSubaccountIndex');
  if (lblAutoTradeSubaccountIndex) lblAutoTradeSubaccountIndex.textContent = t.autoTradeSubaccountIndexLabel;

  const lblAutoTradeTestnet = document.getElementById('lblAutoTradeTestnet');
  if (lblAutoTradeTestnet) lblAutoTradeTestnet.textContent = t.autoTradeTestnetLabel;

  const lblAutoTradeWallet = document.getElementById('lblAutoTradeWallet');
  if (lblAutoTradeWallet) lblAutoTradeWallet.textContent = t.autoTradeWalletLabel;

  const lblAutoTradePrivateKey = document.getElementById('lblAutoTradePrivateKey');
  if (lblAutoTradePrivateKey) lblAutoTradePrivateKey.textContent = t.autoTradePrivateKeyLabel;

  const lblAutoTradeApiKey = document.getElementById('lblAutoTradeApiKey');
  if (lblAutoTradeApiKey) lblAutoTradeApiKey.textContent = t.autoTradeApiKeyLabel;

  const lblAutoTradeApiSecret = document.getElementById('lblAutoTradeApiSecret');
  if (lblAutoTradeApiSecret) lblAutoTradeApiSecret.textContent = t.autoTradeApiSecretLabel;

  const lblAutoTradeAlert = document.getElementById('lblAutoTradeAlert');
  if (lblAutoTradeAlert) lblAutoTradeAlert.textContent = t.autoTradeAlertLabel;

  const lblAutoTradeDirection = document.getElementById('lblAutoTradeDirection');
  if (lblAutoTradeDirection) lblAutoTradeDirection.textContent = t.autoTradeDirectionLabel;

  const autoTradeDirection = document.getElementById('autoTradeDirection');
  if (autoTradeDirection) {
    autoTradeDirection.options[0].textContent = lang === 'en' ? 'Auto (Crossover Badge)' : 'Авто (из пересечения)';
    autoTradeDirection.options[1].textContent = lang === 'en' ? 'Long (Crossover Only)' : 'Лонг (только пересечение)';
    autoTradeDirection.options[2].textContent = lang === 'en' ? 'Short (Crossover Only)' : 'Шорт (только пересечение)';
    autoTradeDirection.options[3].textContent = lang === 'en' ? 'Trend Long (Price Crossover)' : 'Трендовый Лонг (с ростом цены)';
    autoTradeDirection.options[4].textContent = lang === 'en' ? 'Trend Short (Price Crossover)' : 'Трендовый Шорт (с падением цены)';
  }

  const lblAutoTradeOrderCount = document.getElementById('lblAutoTradeOrderCount');
  if (lblAutoTradeOrderCount) lblAutoTradeOrderCount.textContent = t.autoTradeOrderCountLabel;

  const lblAutoTradeAmount = document.getElementById('lblAutoTradeAmount');
  if (lblAutoTradeAmount) lblAutoTradeAmount.textContent = t.autoTradeAmountLabel;

  // Leg labels
  const autoLegRows = document.querySelectorAll('.auto-leg-row');
  autoLegRows.forEach(row => {
    const legNum = row.dataset.leg;
    const offsetLbl = row.querySelector(`.lblLegOffset${legNum}`);
    if (offsetLbl) offsetLbl.textContent = lang === 'en' ? `Order ${legNum} Offset (%)` : `Ордер ${legNum} Отклонение (%)`;
    const amountLbl = row.querySelector(`.lblLegAmount${legNum}`);
    if (amountLbl) amountLbl.textContent = lang === 'en' ? `Order ${legNum} Amount (USD)` : `Ордер ${legNum} Сумма (USD)`;
  });

  const lblAutoTradeUnfilledCancelMinutes = document.getElementById('lblAutoTradeUnfilledCancelMinutes');
  if (lblAutoTradeUnfilledCancelMinutes) lblAutoTradeUnfilledCancelMinutes.textContent = t.autoTradeUnfilledCancelMinutesLabel;

  const lblAutoTradeTpMode = document.getElementById('lblAutoTradeTpMode');
  if (lblAutoTradeTpMode) lblAutoTradeTpMode.textContent = t.autoTradeTpModeLabel;

  const autoTradeTpMode = document.getElementById('autoTradeTpMode');
  if (autoTradeTpMode) {
    autoTradeTpMode.options[0].textContent = lang === 'en' ? 'Percent Offset' : 'Процентное отклонение';
    autoTradeTpMode.options[1].textContent = lang === 'en' ? 'Metric Crossover (Next Signal)' : 'Пересечение показателей (след. сигнал)';
  }

  const lblAutoTradeTpPercent = document.getElementById('lblAutoTradeTpPercent');
  if (lblAutoTradeTpPercent) lblAutoTradeTpPercent.textContent = t.autoTradeTpPercentLabel;

  const lblAutoTradeTpAnchor = document.getElementById('lblAutoTradeTpAnchor');
  if (lblAutoTradeTpAnchor) lblAutoTradeTpAnchor.textContent = t.autoTradeTpAnchorLabel;

  const autoTradeTpAnchor = document.getElementById('autoTradeTpAnchor');
  if (autoTradeTpAnchor) {
    autoTradeTpAnchor.options[0].textContent = lang === 'en' ? 'Average Entry Price' : 'Средняя цена входа';
    autoTradeTpAnchor.options[1].textContent = lang === 'en' ? 'Order 1 Price' : 'Цена 1-го ордера';
    autoTradeTpAnchor.options[2].textContent = lang === 'en' ? 'Order 2 Price' : 'Цена 2-го ордера';
    autoTradeTpAnchor.options[3].textContent = lang === 'en' ? 'Order 3 Price' : 'Цена 3-го ордера';
  }

  const lblAutoTradeTpClose = document.getElementById('lblAutoTradeTpClose');
  if (lblAutoTradeTpClose) lblAutoTradeTpClose.textContent = t.autoTradeTpCloseLabel;

  const lblAutoTradeSlMode = document.getElementById('lblAutoTradeSlMode');
  if (lblAutoTradeSlMode) lblAutoTradeSlMode.textContent = t.autoTradeSlModeLabel;

  const autoTradeSlMode = document.getElementById('autoTradeSlMode');
  if (autoTradeSlMode) {
    autoTradeSlMode.options[0].textContent = lang === 'en' ? 'None' : 'Нет';
    autoTradeSlMode.options[1].textContent = lang === 'en' ? 'Percent Offset' : 'Процентное отклонение';
    autoTradeSlMode.options[2].textContent = lang === 'en' ? 'Metric Crossover (Next Signal)' : 'Пересечение показателей (след. сигнал)';
  }

  const lblAutoTradeSlPercent = document.getElementById('lblAutoTradeSlPercent');
  if (lblAutoTradeSlPercent) lblAutoTradeSlPercent.textContent = t.autoTradeSlPercentLabel;

  const lblAutoTradeSlClose = document.getElementById('lblAutoTradeSlClose');
  if (lblAutoTradeSlClose) lblAutoTradeSlClose.textContent = t.autoTradeSlCloseLabel;

  const lblConfiguredStrategies = document.getElementById('lblConfiguredStrategies');
  if (lblConfiguredStrategies) lblConfiguredStrategies.textContent = t.configuredStrategies;

  const lblConfiguredWallets = document.getElementById('lblConfiguredWallets');
  if (lblConfiguredWallets) lblConfiguredWallets.textContent = t.configuredWallets;

  const createWalletBtn = document.getElementById('createWalletBtn');
  if (createWalletBtn) createWalletBtn.textContent = t.addWallet;

  const lblWalletName = document.getElementById('lblWalletName');
  if (lblWalletName) lblWalletName.textContent = t.walletName;

  const lblWalletExchange = document.getElementById('lblWalletExchange');
  if (lblWalletExchange) lblWalletExchange.textContent = t.walletExchange;

  const lblWalletAddress = document.getElementById('lblWalletAddress');
  if (lblWalletAddress) lblWalletAddress.textContent = t.walletAddress;

  const lblWalletPrivateKey = document.getElementById('lblWalletPrivateKey');
  if (lblWalletPrivateKey) lblWalletPrivateKey.textContent = t.walletPrivateKey;

  const lblWalletApiKey = document.getElementById('lblWalletApiKey');
  if (lblWalletApiKey) lblWalletApiKey.textContent = t.walletApiKey;

  const lblWalletApiSecret = document.getElementById('lblWalletApiSecret');
  if (lblWalletApiSecret) lblWalletApiSecret.textContent = t.walletApiSecret;

  const btnSaveWallet = document.getElementById('btnSaveWallet');
  if (btnSaveWallet) btnSaveWallet.textContent = t.btnSaveWallet;

  const lblStrategyWalletSelect = document.getElementById('lblStrategyWalletSelect');
  if (lblStrategyWalletSelect) lblStrategyWalletSelect.textContent = t.strategyWalletSelect;

  const createStrategyBtn = document.getElementById('createStrategyBtn');
  if (createStrategyBtn) createStrategyBtn.textContent = t.createStrategy;

  const lblStrategyName = document.getElementById('lblStrategyName');
  if (lblStrategyName) lblStrategyName.textContent = t.strategyName;

  const btnCancelAutoTrade = document.getElementById('btnCancelAutoTrade');
  if (btnCancelAutoTrade) btnCancelAutoTrade.textContent = t.btnCancel;

  const btnSaveAutoTrade = document.getElementById('btnSaveAutoTrade');
  if (btnSaveAutoTrade) btnSaveAutoTrade.textContent = t.saveConfigStartBotLabel;

  const titleAutoTradePositions = document.getElementById('titleAutoTradePositions');
  if (titleAutoTradePositions) titleAutoTradePositions.textContent = t.titleAutoTradePositionsLabel;

  const thAutotradeAsset = document.getElementById('thAutotradeAsset');
  if (thAutotradeAsset) thAutotradeAsset.textContent = t.thAutotradeAssetLabel;
  const thAutotradeSide = document.getElementById('thAutotradeSide');
  if (thAutotradeSide) thAutotradeSide.textContent = t.thAutotradeSideLabel;
  const thAutotradeSize = document.getElementById('thAutotradeSize');
  if (thAutotradeSize) thAutotradeSize.textContent = t.thAutotradeSizeLabel;
  const thAutotradeEntry = document.getElementById('thAutotradeEntry');
  if (thAutotradeEntry) thAutotradeEntry.textContent = t.thAutotradeEntryLabel;
  const thAutotradeMark = document.getElementById('thAutotradeMark');
  if (thAutotradeMark) thAutotradeMark.textContent = t.thAutotradeMarkLabel;
  const thAutotradePnl = document.getElementById('thAutotradePnl');
  if (thAutotradePnl) thAutotradePnl.textContent = t.thAutotradePnlLabel;
  const thAutotradeActions = document.getElementById('thAutotradeActions');
  if (thAutotradeActions) thAutotradeActions.textContent = t.thAutotradeActionsLabel;

  const tdAutotradeNoPositions = document.getElementById('tdAutotradeNoPositions');
  if (tdAutotradeNoPositions) tdAutotradeNoPositions.textContent = t.tdAutotradeNoPositionsLabel;

  const titleAutoTradeLogs = document.getElementById('titleAutoTradeLogs');
  if (titleAutoTradeLogs) titleAutoTradeLogs.textContent = t.titleAutoTradeLogsLabel;

  const titleAutoTradeHistory = document.getElementById('titleAutoTradeHistory');
  if (titleAutoTradeHistory) titleAutoTradeHistory.textContent = t.titleAutoTradeHistoryLabel;

  const pAutotradeNoHistory = document.getElementById('pAutotradeNoHistory');
  if (pAutotradeNoHistory) pAutotradeNoHistory.textContent = t.pAutotradeNoHistoryLabel;

  populateAutoTradeCloseAlertSelect();

  // Re-render cached list of alerts in correct language
  if (cachedAlerts.length > 0) {
    renderAlertsList(cachedAlerts);
  }
}

function createExitsConditionRow(containerId, data = null) {
  const lang = localStorage.getItem('hype_twap_lang') || 'en';
  const t = TRANSLATIONS[lang];
  const container = document.getElementById(containerId);
  if (!container) return;
  
  container.innerHTML = '';
  
  const row = document.createElement('div');
  row.className = 'exit-condition-row';
  row.style.display = 'flex';
  row.style.flexDirection = 'column';
  row.style.gap = '8px';
  row.style.background = 'rgba(15, 19, 23, 0.4)';
  row.style.border = '1px solid var(--line)';
  row.style.borderRadius = '6px';
  row.style.padding = '12px';
  row.style.position = 'relative';
  row.style.marginTop = '8px';

  row.innerHTML = `
    <div style="display: grid; grid-template-columns: 2fr 1fr 2fr; gap: 8px; align-items: end;">
      <div class="form-group" style="margin-bottom: 0;">
        <label class="lbl-left-metric" style="font-size: 10px; text-transform: uppercase; color: var(--muted); margin-bottom: 4px;">${t.leftMetric}</label>
        <select class="metric-select left-metric-select" required style="font-size: 12px; padding: 6px; background: #0f1317; border: 1px solid var(--line); color: var(--text); border-radius: 4px; width: 100%;">
        </select>
      </div>

      <div class="form-group" style="margin-bottom: 0;">
        <label class="lbl-operator" style="font-size: 10px; text-transform: uppercase; color: var(--muted); margin-bottom: 4px;">${t.operator}</label>
        <select class="operator-select" required style="font-size: 12px; padding: 6px; background: #0f1317; border: 1px solid var(--line); color: var(--text); border-radius: 4px; width: 100%;">
          <option value="gt">&gt;</option>
          <option value="lt">&lt;</option>
          <option value="gte">&gt;=</option>
          <option value="lte">&lt;=</option>
        </select>
      </div>

      <div class="form-group" style="margin-bottom: 0;">
        <label class="lbl-compare-with" style="font-size: 10px; text-transform: uppercase; color: var(--muted); margin-bottom: 4px;">${t.compareWith}</label>
        <select class="compare-type-select" required style="font-size: 12px; padding: 6px; background: #0f1317; border: 1px solid var(--line); color: var(--text); border-radius: 4px; width: 100%;">
          <option value="value">${t.staticValue}</option>
          <option value="metric">${t.anotherMetric}</option>
        </select>
      </div>
    </div>

    <div class="target-value-group form-group" style="margin-bottom: 0;">
      <label class="lbl-target-value" style="font-size: 10px; text-transform: uppercase; color: var(--muted); margin-bottom: 4px;">${t.targetValue}</label>
      <input type="number" step="any" class="target-value-input" placeholder="${lang === 'en' ? 'e.g. 30000000' : 'напр. 30000000'}" required style="font-size: 12px; padding: 6px; background: #0f1317; border: 1px solid var(--line); color: var(--text); border-radius: 4px; width: 100%;"/>
    </div>

    <div class="target-metric-group form-group hidden" style="margin-bottom: 0;">
      <label class="lbl-right-metric" style="font-size: 10px; text-transform: uppercase; color: var(--muted); margin-bottom: 4px;">${t.rightMetric}</label>
      <select class="metric-select right-metric-select" style="font-size: 12px; padding: 6px; background: #0f1317; border: 1px solid var(--line); color: var(--text); border-radius: 4px; width: 100%;">
      </select>
    </div>
  `;

  const leftSelect = row.querySelector('.left-metric-select');
  const rightSelect = row.querySelector('.right-metric-select');
  populateMetricSelect(leftSelect, lang);
  populateMetricSelect(rightSelect, lang);

  const compareTypeSelect = row.querySelector('.compare-type-select');
  const valueGroup = row.querySelector('.target-value-group');
  const metricGroup = row.querySelector('.target-metric-group');
  const valueInput = row.querySelector('.target-value-input');

  compareTypeSelect.addEventListener('change', () => {
    if (compareTypeSelect.value === 'value') {
      valueGroup.classList.remove('hidden');
      metricGroup.classList.add('hidden');
      valueInput.required = true;
    } else {
      valueGroup.classList.add('hidden');
      metricGroup.classList.remove('hidden');
      valueInput.required = false;
    }
  });

  if (data) {
    leftSelect.value = data.field1;
    row.querySelector('.operator-select').value = data.operator;
    compareTypeSelect.value = data.compareType;
    if (data.compareType === 'value') {
      valueInput.value = data.value;
      valueGroup.classList.remove('hidden');
      metricGroup.classList.add('hidden');
      valueInput.required = true;
    } else {
      rightSelect.value = data.field2;
      valueGroup.classList.add('hidden');
      metricGroup.classList.remove('hidden');
      valueInput.required = false;
    }
  }

  container.appendChild(row);
}

function getCustomExitCondition(containerId) {
  const container = document.getElementById(containerId);
  if (!container || container.classList.contains('hidden')) return null;
  const row = container.querySelector('.exit-condition-row');
  if (!row) return null;
  
  const field1 = row.querySelector('.left-metric-select').value;
  const operator = row.querySelector('.operator-select').value;
  const compareType = row.querySelector('.compare-type-select').value;
  const valueInput = row.querySelector('.target-value-input');
  const value = valueInput ? parseFloat(valueInput.value) : 0;
  const field2 = row.querySelector('.right-metric-select').value;
  
  return {
    field1,
    operator,
    compareType,
    value,
    field2
  };
}

function initBacktestConfigurator() {
  const tabBacktest = document.getElementById('tabBacktest');
  const tabContentBacktest = document.getElementById('tabContentBacktest');
  const backtestForm = document.getElementById('backtestForm');
  const backtestAlertSelect = document.getElementById('backtestAlertSelect');
  const backtestModeSelect = document.getElementById('backtestModeSelect');
  const gridSettingsBlock = document.getElementById('gridSettingsBlock');
  const backtestOrderCount = document.getElementById('backtestOrderCount');
  const gridLegsContainer = document.getElementById('gridLegsContainer');
  const backtestTpCloseGroup = document.getElementById('backtestTpCloseGroup');
  const backtestSlCloseGroup = document.getElementById('backtestSlCloseGroup');

  // Set default date range: 30 days ago to today
  const backtestStartDate = document.getElementById('backtestStartDate');
  const backtestEndDate = document.getElementById('backtestEndDate');
  if (backtestStartDate && backtestEndDate) {
    const today = new Date();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    // Format YYYY-MM-DD local time safely
    const formatLocalDate = (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };
    backtestStartDate.value = formatLocalDate(thirtyDaysAgo);
    backtestEndDate.value = formatLocalDate(today);
  }

  // Toggle TP mode offset visibility and close alert group visibility
  const backtestTpMode = document.getElementById('backtestTpMode');
  const tpPercentSettingsGroup = document.getElementById('tpPercentSettingsGroup');
  const backtestSlMode = document.getElementById('backtestSlMode');
  const slPercentSettingsGroup = document.getElementById('slPercentSettingsGroup');

  const updateCloseAlertVisibility = () => {
    if (backtestTpCloseGroup && backtestTpMode) {
      if (backtestTpMode.value === 'metric') {
        backtestTpCloseGroup.classList.remove('hidden');
      } else {
        backtestTpCloseGroup.classList.add('hidden');
      }
    }
    if (backtestSlCloseGroup && backtestSlMode) {
      if (backtestSlMode.value === 'metric') {
        backtestSlCloseGroup.classList.remove('hidden');
      } else {
        backtestSlCloseGroup.classList.add('hidden');
      }
    }
  };

  if (backtestTpMode && tpPercentSettingsGroup) {
    backtestTpMode.addEventListener('change', () => {
      if (backtestTpMode.value === 'percent') {
        tpPercentSettingsGroup.classList.remove('hidden');
      } else {
        tpPercentSettingsGroup.classList.add('hidden');
      }
      updateCloseAlertVisibility();
    });
  }

  // Toggle SL mode offset visibility and close alert group visibility
  if (backtestSlMode && slPercentSettingsGroup) {
    backtestSlMode.addEventListener('change', () => {
      if (backtestSlMode.value === 'percent') {
        slPercentSettingsGroup.classList.remove('hidden');
      } else {
        slPercentSettingsGroup.classList.add('hidden');
      }
      updateCloseAlertVisibility();
    });
  }

  const backtestTpCloseSelect = document.getElementById('backtestTpCloseSelect');
  const backtestTpCloseCustomContainer = document.getElementById('backtestTpCloseCustomContainer');
  if (backtestTpCloseSelect && backtestTpCloseCustomContainer) {
    backtestTpCloseSelect.addEventListener('change', () => {
      if (backtestTpCloseSelect.value === 'custom') {
        backtestTpCloseCustomContainer.classList.remove('hidden');
        if (backtestTpCloseCustomContainer.children.length === 0) {
          createExitsConditionRow('backtestTpCloseCustomContainer');
        }
      } else {
        backtestTpCloseCustomContainer.classList.add('hidden');
      }
    });
  }

  const backtestSlCloseSelect = document.getElementById('backtestSlCloseSelect');
  const backtestSlCloseCustomContainer = document.getElementById('backtestSlCloseCustomContainer');
  if (backtestSlCloseSelect && backtestSlCloseCustomContainer) {
    backtestSlCloseSelect.addEventListener('change', () => {
      if (backtestSlCloseSelect.value === 'custom') {
        backtestSlCloseCustomContainer.classList.remove('hidden');
        if (backtestSlCloseCustomContainer.children.length === 0) {
          createExitsConditionRow('backtestSlCloseCustomContainer');
        }
      } else {
        backtestSlCloseCustomContainer.classList.add('hidden');
      }
    });
  }

  // Tab switching
  if (tabBacktest) {
    tabBacktest.addEventListener('click', () => {
      tabBacktest.classList.add('active');
      alertElements.tabActiveAlerts.classList.remove('active');
      alertElements.tabCreateAlert.classList.remove('active');

      tabContentBacktest.classList.remove('hidden');
      alertElements.tabContentList.classList.add('hidden');
      alertElements.tabContentForm.classList.add('hidden');

      populateBacktestAlertSelect();
      populateBacktestCloseAlertSelect();
    });
  }

  // Hide/show simulation settings depending on mode
  if (backtestModeSelect) {
    backtestModeSelect.addEventListener('change', () => {
      const mode = backtestModeSelect.value;
      if (mode === 'trading') {
        if (gridSettingsBlock) gridSettingsBlock.classList.remove('hidden');
      } else {
        if (gridSettingsBlock) gridSettingsBlock.classList.add('hidden');
      }
    });
    // Trigger initial change
    backtestModeSelect.dispatchEvent(new Event('change'));
  }

  // Hide/show order legs based on order count
  if (backtestOrderCount) {
    backtestOrderCount.addEventListener('change', () => {
      const count = parseInt(backtestOrderCount.value) || 3;
      if (gridLegsContainer) {
        const legRows = gridLegsContainer.querySelectorAll('.grid-leg-row');
        legRows.forEach(row => {
          const legNum = parseInt(row.dataset.leg);
          if (legNum <= count) {
            row.style.display = 'grid';
          } else {
            row.style.display = 'none';
          }
        });
      }
    });
    // Trigger initial change
    backtestOrderCount.dispatchEvent(new Event('change'));
  }

  // Handle Form Submission
  if (backtestForm) {
    backtestForm.addEventListener('submit', runLocalBacktest);
  }
}

function populateBacktestAlertSelect() {
  const backtestAlertSelect = document.getElementById('backtestAlertSelect');
  if (!backtestAlertSelect) return;
  
  const currentVal = backtestAlertSelect.value;
  backtestAlertSelect.innerHTML = '';
  
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.disabled = true;
  defaultOpt.selected = !currentVal;
  const currentLang = localStorage.getItem('hype_twap_lang') || 'en';
  defaultOpt.textContent = currentLang === 'en' ? 'Select Alert...' : 'Выберите алерт...';
  backtestAlertSelect.appendChild(defaultOpt);
  
  cachedAlerts.forEach(alert => {
    const opt = document.createElement('option');
    opt.value = alert.id;
    opt.textContent = `${alert.name} (${alert.timeframe || '1m'})`;
    if (alert.id === currentVal) {
      opt.selected = true;
    }
    backtestAlertSelect.appendChild(opt);
  });
}

function populateBacktestCloseAlertSelect() {
  const tpSelect = document.getElementById('backtestTpCloseSelect');
  const slSelect = document.getElementById('backtestSlCloseSelect');
  const currentLang = localStorage.getItem('hype_twap_lang') || 'en';
  
  const populate = (select) => {
    if (!select) return;
    const currentVal = select.value;
    select.innerHTML = '';
    
    const sameOpt = document.createElement('option');
    sameOpt.value = 'same';
    sameOpt.textContent = currentLang === 'en' ? 'Same as Signal Alert' : 'По умолчанию (текущий)';
    sameOpt.selected = !currentVal || currentVal === 'same';
    select.appendChild(sameOpt);
    
    const customOpt = document.createElement('option');
    customOpt.value = 'custom';
    customOpt.textContent = currentLang === 'en' ? 'Custom Condition...' : 'Своё условие...';
    customOpt.selected = currentVal === 'custom';
    select.appendChild(customOpt);
    
    cachedAlerts.forEach(alert => {
      const opt = document.createElement('option');
      opt.value = alert.id;
      opt.textContent = `${alert.name} (${alert.timeframe || '1m'})`;
      if (alert.id === currentVal) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });
  };

  populate(tpSelect);
  populate(slSelect);
}

async function runLocalBacktest(e) {
  e.preventDefault();
  const feedback = document.getElementById('backtestFeedback');
  const runBtn = document.getElementById('btnRunBacktest');
  const currentLang = localStorage.getItem('hype_twap_lang') || 'en';
  
  feedback.className = 'feedback-msg';
  feedback.textContent = currentLang === 'en' ? 'Running simulation...' : 'Запуск теста...';
  runBtn.disabled = true;

  try {
    const startDateVal = document.getElementById('backtestStartDate').value;
    const endDateVal = document.getElementById('backtestEndDate').value;
    const alertId = document.getElementById('backtestAlertSelect').value;
    const mode = document.getElementById('backtestModeSelect').value;
    const directionOverride = document.getElementById('backtestDirectionSelect').value;
    const tradeAmount = parseFloat(document.getElementById('backtestTradeAmount').value) || null;
    
    if (!startDateVal || !endDateVal) {
      throw new Error(currentLang === 'en' ? 'Please select a valid date range.' : 'Пожалуйста, выберите корректный диапазон дат.');
    }
    
    if (!alertId) {
      throw new Error(currentLang === 'en' ? 'Please select a trigger alert.' : 'Пожалуйста, выберите сигнальное оповещение.');
    }
    
    const alert = cachedAlerts.find(a => a.id === alertId);
    if (!alert) {
      throw new Error(currentLang === 'en' ? 'Selected alert not found.' : 'Выбранный алерт не найден.');
    }
    
    feedback.textContent = currentLang === 'en' ? 'Fetching historical 1m data...' : 'Загрузка исторических 1м данных...';
    const response = await fetch('/api/snapshots?timeframe=1m');
    if (!response.ok) {
      throw new Error(`Failed to load historical data: ${response.statusText}`);
    }
    const allSnapshots1m = await response.json();
    
    // Parse start and end dates locally
    const startMs = new Date(startDateVal + 'T00:00:00').getTime();
    const endMs = new Date(endDateVal + 'T23:59:59').getTime();
    const snapshots1m = allSnapshots1m.filter(s => {
      const t = new Date(s.timestamp).getTime();
      return t >= startMs && t <= endMs;
    });
    
    if (snapshots1m.length === 0) {
      throw new Error(currentLang === 'en' ? 'No historical data found for the selected period.' : 'Нет исторических данных за выбранный период.');
    }
    
    feedback.textContent = currentLang === 'en' ? 'Identifying signals...' : 'Поиск сигналов...';
    const signals = generateBacktestSignals(snapshots1m, alert, directionOverride);
    
    if (signals.length === 0) {
      feedback.className = 'feedback-msg error';
      feedback.textContent = currentLang === 'en' ? 'No signals found in this period.' : 'Сигналы за этот период не найдены.';
      document.getElementById('backtestTradingResults').classList.add('hidden');
      document.getElementById('backtestMetricsResults').classList.add('hidden');
      priceSeries.setMarkers([]);
      runBtn.disabled = false;
      return;
    }
    
    const tpCloseAlertId = document.getElementById('backtestTpCloseSelect')?.value || 'same';
    const slCloseAlertId = document.getElementById('backtestSlCloseSelect')?.value || 'same';
    
    let tpCloseSignals = [];
    if (tpCloseAlertId && tpCloseAlertId !== 'same' && tpCloseAlertId !== 'custom') {
      const tpCloseAlert = cachedAlerts.find(a => a.id === tpCloseAlertId);
      if (tpCloseAlert) {
        tpCloseSignals = generateBacktestSignals(snapshots1m, tpCloseAlert, 'auto');
      } else {
        tpCloseSignals = signals;
      }
    } else {
      tpCloseSignals = signals;
    }

    let slCloseSignals = [];
    if (slCloseAlertId && slCloseAlertId !== 'same' && slCloseAlertId !== 'custom') {
      const slCloseAlert = cachedAlerts.find(a => a.id === slCloseAlertId);
      if (slCloseAlert) {
        slCloseSignals = generateBacktestSignals(snapshots1m, slCloseAlert, 'auto');
      } else {
        slCloseSignals = signals;
      }
    } else {
      slCloseSignals = signals;
    }
    
    if (mode === 'trading') {
      feedback.textContent = currentLang === 'en' ? 'Simulating trades...' : 'Симуляция сделок...';
      
      const count = parseInt(document.getElementById('backtestOrderCount').value) || 3;
      const legs = [];
      const rows = document.querySelectorAll('.grid-leg-row');
      rows.forEach(row => {
        const legNum = parseInt(row.dataset.leg);
        if (legNum <= count) {
          const offsetInput = row.querySelector('.leg-offset');
          const amountInput = row.querySelector('.leg-amount');
          
          let amount = parseFloat(amountInput.value) || 0;
          if (tradeAmount !== null) {
            amount = tradeAmount / count;
          }
          
          legs.push({
            offset: parseFloat(offsetInput.value) || 0,
            amount: amount
          });
        }
      });

      const results = runTradingSimulation(snapshots1m, signals, legs, tpCloseSignals, slCloseSignals);
      renderTradingResults(results);
    } else {
      feedback.textContent = currentLang === 'en' ? 'Analyzing price deviation metrics...' : 'Анализ отклонения цен...';
      const results = runMetricsAnalysis(snapshots1m, signals, tpCloseSignals, slCloseSignals, tradeAmount);
      renderMetricsResults(results);
    }
    
    feedback.className = 'feedback-msg success';
    feedback.textContent = currentLang === 'en' ? 'Success!' : 'Успешно!';
  } catch (err) {
    feedback.className = 'feedback-msg error';
    feedback.textContent = err.message;
    console.error('Backtest error:', err);
  } finally {
    runBtn.disabled = false;
  }
}

function generateBacktestSignals(snapshots1m, alert, directionOverride) {
  const TIMEFRAMES = {
    '1m': 60_000,
    '5m': 5 * 60_000,
    '15m': 15 * 60_000,
    '1h': 60 * 60_000,
    '4h': 4 * 60 * 60_000,
    '1d': 24 * 60 * 60_000
  };
  
  const timeframe = alert.timeframe || '1m';
  const timeframeMs = TIMEFRAMES[timeframe] || TIMEFRAMES['1m'];
  
  let completedBuckets = [];
  let activeBucket = null;
  let lastTriggerPrice = null;
  let lastCrossoverBucketStartMs = null;
  let lastTriggerTime = 0;
  const signals = [];
  
  for (let i = 0; i < snapshots1m.length; i++) {
    const s = snapshots1m[i];
    const startMs = Math.floor(new Date(s.timestamp).getTime() / timeframeMs) * timeframeMs;
    
    if (activeBucket && activeBucket.startMs !== startMs) {
      completedBuckets.push(finalizeActiveBucket(activeBucket));
      activeBucket = null;
    }
    
    if (!activeBucket) {
      activeBucket = {
        startMs,
        timestamp: s.timestamp,
        open: Number.isFinite(s.open) ? s.open : s.price,
        high: Number.isFinite(s.high) ? s.high : s.price,
        low: Number.isFinite(s.low) ? s.low : s.price,
        close: Number.isFinite(s.close) ? s.close : s.price,
        sums: {},
        counts: {},
        twapModes: {
          spotPerp: { sums: {}, counts: {} },
          spot: { sums: {}, counts: {} },
          perp: { sums: {}, counts: {} }
        }
      };
    } else {
      const highVal = Number.isFinite(s.high) ? s.high : s.price;
      const lowVal = Number.isFinite(s.low) ? s.low : s.price;
      if (highVal > activeBucket.high) activeBucket.high = highVal;
      if (lowVal < activeBucket.low) activeBucket.low = lowVal;
      activeBucket.close = Number.isFinite(s.close) ? s.close : s.price;
    }
    
    for (const key of Object.keys(s)) {
      if (key === 'timestamp' || key === 'open' || key === 'high' || key === 'low' || key === 'close' || key === 'price' || key === 'twapModes' || key === 'status') {
        continue;
      }
      if (Number.isFinite(s[key])) {
        activeBucket.sums[key] = (activeBucket.sums[key] || 0) + s[key];
        activeBucket.counts[key] = (activeBucket.counts[key] || 0) + 1;
      }
    }
    
    const modes = ['spotPerp', 'spot', 'perp'];
    for (const mode of modes) {
      const modeData = s.twapModes?.[mode];
      if (modeData) {
        for (const key of Object.keys(modeData)) {
          if (Number.isFinite(modeData[key])) {
            activeBucket.twapModes[mode].sums[key] = (activeBucket.twapModes[mode].sums[key] || 0) + modeData[key];
            activeBucket.twapModes[mode].counts[key] = (activeBucket.twapModes[mode].counts[key] || 0) + 1;
          }
        }
      }
    }
    
    const currentBucketAgg = finalizeActiveBucket(activeBucket);
    const previousBucketAgg = completedBuckets.length > 0 ? completedBuckets[completedBuckets.length - 1] : null;
    
    const isTriggered = evaluateExpression(currentBucketAgg, alert.expression);
    if (isTriggered) {
      const currentPrice = currentBucketAgg.price;
      const wasTriggeredPrev = previousBucketAgg ? evaluateExpression(previousBucketAgg, alert.expression) : false;
      
      let shouldTrigger = false;
      let signalType = 'long';

      const dirMode = directionOverride || 'auto';

      if (dirMode === 'long') {
        if (!wasTriggeredPrev && lastCrossoverBucketStartMs !== startMs) {
          shouldTrigger = true;
          lastCrossoverBucketStartMs = startMs;
        }
        signalType = 'long';
      } else if (dirMode === 'short') {
        if (!wasTriggeredPrev && lastCrossoverBucketStartMs !== startMs) {
          shouldTrigger = true;
          lastCrossoverBucketStartMs = startMs;
        }
        signalType = 'short';
      } else if (dirMode === 'trend_long') {
        if (!wasTriggeredPrev && lastCrossoverBucketStartMs !== startMs) {
          if (lastTriggerPrice === null || currentPrice > lastTriggerPrice) {
            shouldTrigger = true;
          }
          lastTriggerPrice = currentPrice;
          lastCrossoverBucketStartMs = startMs;
        }
        signalType = 'long';
      } else if (dirMode === 'trend_short') {
        if (!wasTriggeredPrev && lastCrossoverBucketStartMs !== startMs) {
          if (lastTriggerPrice === null || currentPrice < lastTriggerPrice) {
            shouldTrigger = true;
          }
          lastTriggerPrice = currentPrice;
          lastCrossoverBucketStartMs = startMs;
        }
        signalType = 'short';
      } else { // 'auto'
        const alertTrendMode = alert.trend_mode || 'none';
        if (alertTrendMode === 'long') {
          if (!wasTriggeredPrev && lastCrossoverBucketStartMs !== startMs) {
            if (lastTriggerPrice === null || currentPrice > lastTriggerPrice) {
              shouldTrigger = true;
            }
            lastTriggerPrice = currentPrice;
            lastCrossoverBucketStartMs = startMs;
          }
          signalType = 'long';
        } else if (alertTrendMode === 'short') {
          if (!wasTriggeredPrev && lastCrossoverBucketStartMs !== startMs) {
            if (lastTriggerPrice === null || currentPrice < lastTriggerPrice) {
              shouldTrigger = true;
            }
            lastTriggerPrice = currentPrice;
            lastCrossoverBucketStartMs = startMs;
          }
          signalType = 'short';
        } else { // 'none'
          if (!wasTriggeredPrev && lastCrossoverBucketStartMs !== startMs) {
            shouldTrigger = true;
            lastCrossoverBucketStartMs = startMs;
          }
          signalType = 'long';
        }
      }
      
      if (shouldTrigger) {
        const sTime = new Date(s.timestamp).getTime();
        const cooldownMs = (alert.frequency_minutes || 0) * 60_000;
        if (sTime - lastTriggerTime >= cooldownMs) {
          signals.push({
            timestamp: s.timestamp,
            price: s.price,
            type: signalType,
            index: i
          });
          lastTriggerTime = sTime;
        }
      }
    }
  }
  
  return signals;
}

function finalizeActiveBucket(b) {
  const bucket = {
    timestamp: b.timestamp,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    price: b.close
  };
  for (const key of Object.keys(b.sums)) {
    bucket[key] = b.sums[key] / b.counts[key];
  }
  bucket.twapModes = {};
  for (const mode of Object.keys(b.twapModes)) {
    bucket.twapModes[mode] = {};
    const modeData = b.twapModes[mode];
    for (const key of Object.keys(modeData.sums)) {
      bucket.twapModes[mode][key] = modeData.sums[key] / modeData.counts[key];
    }
  }
  return bucket;
}

function evaluateExpression(snapshot, expr) {
  if (!expr) return false;

  if (expr.type === 'compound') {
    const conditions = expr.conditions || [];
    if (conditions.length === 0) return false;

    if (expr.logicalOperator === 'or') {
      return conditions.some(cond => evaluateExpression(snapshot, cond));
    } else {
      return conditions.every(cond => evaluateExpression(snapshot, cond));
    }
  }

  if (!expr.field1 || !expr.operator) return false;

  const v1 = snapshot[expr.field1];
  if (v1 === null || v1 === undefined) return false;

  let v2;
  if (expr.compareType === 'value') {
    v2 = expr.value;
  } else {
    v2 = snapshot[expr.field2];
  }
  if (v2 === null || v2 === undefined) return false;

  const num1 = Number(v1);
  const num2 = Number(v2);

  if (!Number.isFinite(num1) || !Number.isFinite(num2)) return false;

  switch (expr.operator) {
    case 'gt': return num1 > num2;
    case 'lt': return num1 < num2;
    case 'gte': return num1 >= num2;
    case 'lte': return num1 <= num2;
    default: return false;
  }
}

function runTradingSimulation(snapshots1m, signals, legs, tpCloseSignals, slCloseSignals) {
  const tpMode = document.getElementById('backtestTpMode')?.value || 'percent';
  const tpPercent = parseFloat(document.getElementById('backtestTpPercent')?.value) || 1.5;
  const tpAnchor = document.getElementById('backtestTpAnchor')?.value || 'avg';
  
  const slMode = document.getElementById('backtestSlMode')?.value || 'none';
  const slPercent = parseFloat(document.getElementById('backtestSlPercent')?.value) || 2.0;
  
  const tpCustomExpr = getCustomExitCondition('backtestTpCloseCustomContainer');
  const slCustomExpr = getCustomExitCondition('backtestSlCloseCustomContainer');

  let lastClosedIndex = -1;
  const trades = [];
  const markers = [];

  const safeTpCloseSignals = tpCloseSignals || [];
  const safeSlCloseSignals = slCloseSignals || [];

  for (let sIdx = 0; sIdx < signals.length; sIdx++) {
    const signal = signals[sIdx];
    if (signal.index <= lastClosedIndex) {
      continue;
    }
    
    const triggerPrice = signal.price;
    const isShort = (signal.type === 'short');
    
    const nextTpCloseSignal = !tpCustomExpr ? safeTpCloseSignals.find(cs => cs.index > signal.index) : null;
    const nextSlCloseSignal = !slCustomExpr ? safeSlCloseSignals.find(cs => cs.index > signal.index) : null;
    
    const limitOrders = legs.map((leg, index) => {
      const offsetPct = Math.abs(leg.offset);
      const limitPrice = isShort 
        ? triggerPrice * (1 + offsetPct / 100) 
        : triggerPrice * (1 - offsetPct / 100);
      return {
        id: index + 1,
        limitPrice,
        amount: leg.amount,
        filled: false
      };
    });

    let filledPositions = [];
    let active = true;
    let exitTime = null;
    let exitPrice = null;
    let tradeMaxDrawdown = 0;
    
    let k = signal.index;
    for (; k < snapshots1m.length; k++) {
      const s = snapshots1m[k];
      
      // Check cancels/fills if no orders filled yet
      const order1Price = limitOrders[0].limitPrice;
      
      // Evaluate Exit Signals
      let exitSignalTriggered = false;
      let exitSignalPrice = null;
      let exitSignalIndex = null;
      let exitSignalReason = "";
      
      if (tpMode === 'metric') {
        if (tpCustomExpr) {
          if (evaluateExpression(s, tpCustomExpr)) {
            exitSignalTriggered = true;
            exitSignalPrice = s.price;
            exitSignalIndex = k;
            exitSignalReason = "TP Metric Exit";
          }
        } else if (nextTpCloseSignal && k >= nextTpCloseSignal.index) {
          exitSignalTriggered = true;
          exitSignalPrice = nextTpCloseSignal.price;
          exitSignalIndex = nextTpCloseSignal.index;
          exitSignalReason = "TP Metric Exit";
        }
      }
      
      if (!exitSignalTriggered && slMode === 'metric') {
        if (slCustomExpr) {
          if (evaluateExpression(s, slCustomExpr)) {
            exitSignalTriggered = true;
            exitSignalPrice = s.price;
            exitSignalIndex = k;
            exitSignalReason = "SL Metric Exit";
          }
        } else if (nextSlCloseSignal && k >= nextSlCloseSignal.index) {
          exitSignalTriggered = true;
          exitSignalPrice = nextSlCloseSignal.price;
          exitSignalIndex = nextSlCloseSignal.index;
          exitSignalReason = "SL Metric Exit";
        }
      }
      
      if (filledPositions.length === 0) {
        if (tpMode === 'percent') {
          const cancelPrice = isShort 
            ? order1Price * (1 - tpPercent / 100) 
            : order1Price * (1 + tpPercent / 100);
          
          let tpTargetReached = false;
          if (isShort) {
            if (s.low <= cancelPrice) tpTargetReached = true;
          } else {
            if (s.high >= cancelPrice) tpTargetReached = true;
          }
          if (tpTargetReached) {
            lastClosedIndex = k;
            active = false;
            break;
          }
        }
        
        if (exitSignalTriggered) {
          lastClosedIndex = exitSignalIndex - 1;
          active = false;
          break;
        }
      }

      // Check fills
      limitOrders.forEach(ord => {
        if (!ord.filled) {
          let canFill = false;
          if (isShort) {
            if (s.high >= ord.limitPrice) canFill = true;
          } else {
            if (s.low <= ord.limitPrice) canFill = true;
          }
          if (canFill) {
            ord.filled = true;
            filledPositions.push({
              price: ord.limitPrice,
              amount: ord.amount,
              qty: ord.amount / ord.limitPrice
            });
            
            markers.push({
              time: getLocalTimestamp(s.timestamp),
              position: isShort ? 'aboveBar' : 'belowBar',
              color: isShort ? '#ef5e5e' : '#35d083',
              shape: isShort ? 'arrowDown' : 'arrowUp',
              text: `${isShort ? 'Short' : 'Buy'} L${ord.id} $${ord.limitPrice.toFixed(4)}`
            });
          }
        }
      });
      
      if (filledPositions.length > 0) {
        const totalQty = filledPositions.reduce((sum, p) => sum + p.qty, 0);
        const totalCost = filledPositions.reduce((sum, p) => sum + p.amount, 0);
        const avgPrice = totalCost / totalQty;
        
        let tpAnchorPrice = avgPrice;
        if (tpAnchor === 'order1' && limitOrders[0].filled) tpAnchorPrice = limitOrders[0].limitPrice;
        else if (tpAnchor === 'order2' && limitOrders[1] && limitOrders[1].filled) tpAnchorPrice = limitOrders[1].limitPrice;
        else if (tpAnchor === 'order3' && limitOrders[2] && limitOrders[2].filled) tpAnchorPrice = limitOrders[2].limitPrice;
        
        const tpPrice = isShort 
          ? tpAnchorPrice * (1 - tpPercent / 100)
          : tpAnchorPrice * (1 + tpPercent / 100);
          
        const currentLow = Number.isFinite(s.low) ? s.low : s.price;
        const currentHigh = Number.isFinite(s.high) ? s.high : s.price;
        let currentDrawdown = 0;
        if (isShort) {
          currentDrawdown = ((currentHigh - avgPrice) / avgPrice) * 100;
        } else {
          currentDrawdown = ((avgPrice - currentLow) / avgPrice) * 100;
        }
        if (currentDrawdown > tradeMaxDrawdown) {
          tradeMaxDrawdown = currentDrawdown;
        }
        
        // 1. Check Stop Loss Percent
        if (slMode === 'percent') {
          let slHit = false;
          const slPrice = isShort 
            ? avgPrice * (1 + slPercent / 100)
            : avgPrice * (1 - slPercent / 100);
            
          if (isShort) {
            if (currentHigh >= slPrice) slHit = true;
          } else {
            if (currentLow <= slPrice) slHit = true;
          }
          
          if (slHit) {
            exitTime = s.timestamp;
            exitPrice = slPrice;
            
            const profit = isShort 
              ? totalQty * (avgPrice - slPrice)
              : totalQty * (slPrice - avgPrice);
              
            trades.push({
              profit,
              maxDrawdown: tradeMaxDrawdown
            });
            
            markers.push({
              time: getLocalTimestamp(s.timestamp),
              position: isShort ? 'aboveBar' : 'belowBar',
              color: '#ef5e5e',
              shape: isShort ? 'arrowDown' : 'arrowUp',
              text: `SL $${slPrice.toFixed(4)}`
            });
            
            lastClosedIndex = k;
            active = false;
            break;
          }
        }
        
        // 2. Check Take Profit Percent
        if (tpMode === 'percent') {
          let tpHit = false;
          if (isShort) {
            if (currentLow <= tpPrice) tpHit = true;
          } else {
            if (currentHigh >= tpPrice) tpHit = true;
          }
          
          if (tpHit) {
            exitTime = s.timestamp;
            exitPrice = tpPrice;
            
            const profit = isShort 
              ? totalQty * (avgPrice - tpPrice)
              : totalQty * (tpPrice - avgPrice);
              
            trades.push({
              profit,
              maxDrawdown: tradeMaxDrawdown
            });
            
            markers.push({
              time: getLocalTimestamp(s.timestamp),
              position: isShort ? 'belowBar' : 'aboveBar',
              color: isShort ? '#35d083' : '#ef5e5e',
              shape: isShort ? 'arrowUp' : 'arrowDown',
              text: `TP $${tpPrice.toFixed(4)}`
            });
            
            lastClosedIndex = k;
            active = false;
            break;
          }
        }
        
        // 3. Check Metric Crossover Exit (TP or SL)
        if (exitSignalTriggered) {
          exitTime = s.timestamp;
          exitPrice = exitSignalPrice;
          
          const profit = isShort 
            ? totalQty * (avgPrice - exitPrice)
            : totalQty * (exitPrice - avgPrice);
            
          trades.push({
            profit,
            maxDrawdown: tradeMaxDrawdown
          });
          
          const isWin = profit > 0;
          markers.push({
            time: getLocalTimestamp(s.timestamp),
            position: isWin ? (isShort ? 'belowBar' : 'aboveBar') : (isShort ? 'aboveBar' : 'belowBar'),
            color: isWin ? '#35d083' : '#ef5e5e',
            shape: isWin ? (isShort ? 'arrowUp' : 'arrowDown') : (isShort ? 'arrowDown' : 'arrowUp'),
            text: `${exitSignalReason} $${exitPrice.toFixed(4)}`
          });
          
          lastClosedIndex = exitSignalIndex;
          active = false;
          break;
        }
      }
    }
    
    if (active && filledPositions.length > 0) {
      const lastSnap = snapshots1m[snapshots1m.length - 1];
      const totalQty = filledPositions.reduce((sum, p) => sum + p.qty, 0);
      const totalCost = filledPositions.reduce((sum, p) => sum + p.amount, 0);
      const avgPrice = totalCost / totalQty;
      
      exitPrice = lastSnap.price;
      exitTime = lastSnap.timestamp;
      
      const profit = isShort 
        ? totalQty * (avgPrice - exitPrice)
        : totalQty * (exitPrice - avgPrice);
        
      trades.push({
        profit,
        maxDrawdown: tradeMaxDrawdown
      });
      
      markers.push({
        time: getLocalTimestamp(lastSnap.timestamp),
        position: isShort ? 'belowBar' : 'aboveBar',
        color: '#888888',
        shape: 'square',
        text: `End Exit $${exitPrice.toFixed(4)}`
      });
      
      lastClosedIndex = snapshots1m.length - 1;
    }
  }

  const totalTrades = trades.length;
  const winningTradeObjects = trades.filter(t => t.profit > 0);
  const losingTradeObjects = trades.filter(t => t.profit < 0);
  
  const totalWinsCount = winningTradeObjects.length;
  const totalLossesCount = losingTradeObjects.length;
  const winRate = totalTrades > 0 ? (totalWinsCount / totalTrades) * 100 : 0;
  const netProfit = trades.reduce((sum, t) => sum + t.profit, 0);
  const maxDrawdown = trades.length > 0 ? Math.max(...trades.map(t => t.maxDrawdown)) : 0;

  const grossProfit = winningTradeObjects.reduce((sum, t) => sum + t.profit, 0);
  const grossLoss = Math.abs(losingTradeObjects.reduce((sum, t) => sum + t.profit, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
  
  const avgWin = totalWinsCount > 0 ? grossProfit / totalWinsCount : 0;
  const avgLoss = totalLossesCount > 0 ? grossLoss / totalLossesCount : 0;
  
  const maxWin = totalWinsCount > 0 ? Math.max(...winningTradeObjects.map(t => t.profit)) : 0;
  const maxLoss = totalLossesCount > 0 ? Math.max(...losingTradeObjects.map(t => Math.abs(t.profit))) : 0;

  return {
    totalTrades,
    winRate,
    netProfit,
    maxDrawdown,
    profitFactor,
    avgWin,
    avgLoss,
    maxWin,
    maxLoss,
    totalWinsCount,
    totalLossesCount,
    markers
  };
}

function runMetricsAnalysis(snapshots1m, signals, tpCloseSignals, slCloseSignals, tradeAmount) {
  const drawdowns = [];
  const upsides = [];
  const markers = [];
  const metricTrades = [];

  const tpMode = document.getElementById('backtestTpMode')?.value || 'percent';
  const tpPercent = parseFloat(document.getElementById('backtestTpPercent')?.value) || 1.5;
  const slMode = document.getElementById('backtestSlMode')?.value || 'none';
  const slPercent = parseFloat(document.getElementById('backtestSlPercent')?.value) || 2.0;

  const tpCustomExpr = getCustomExitCondition('backtestTpCloseCustomContainer');
  const slCustomExpr = getCustomExitCondition('backtestSlCloseCustomContainer');

  const safeTpCloseSignals = tpCloseSignals || [];
  const safeSlCloseSignals = slCloseSignals || [];

  for (const signal of signals) {
    const triggerPrice = signal.price;
    const isShort = (signal.type === 'short');
    
    markers.push({
      time: getLocalTimestamp(signal.timestamp),
      position: isShort ? 'aboveBar' : 'belowBar',
      color: isShort ? '#ef5e5e' : '#35d083',
      shape: isShort ? 'arrowDown' : 'arrowUp',
      text: `Signal ${isShort ? 'S' : 'L'}`
    });

    const windowMinutes = 1440; // 24h
    const endIndex = Math.min(signal.index + windowMinutes, snapshots1m.length - 1);
    
    let lowPrice = Infinity;
    let highPrice = -Infinity;
    
    for (let k = signal.index + 1; k <= endIndex; k++) {
      const s = snapshots1m[k];
      const sLow = Number.isFinite(s.low) ? s.low : s.price;
      const sHigh = Number.isFinite(s.high) ? s.high : s.price;
      if (sLow < lowPrice) lowPrice = sLow;
      if (sHigh > highPrice) highPrice = sHigh;
    }

    if (lowPrice !== Infinity && highPrice !== -Infinity) {
      let downsidePercent = 0;
      let upsidePercent = 0;
      if (isShort) {
        downsidePercent = Math.max(0, ((highPrice - triggerPrice) / triggerPrice) * 100);
        upsidePercent = Math.max(0, ((triggerPrice - lowPrice) / triggerPrice) * 100);
      } else {
        downsidePercent = Math.max(0, ((triggerPrice - lowPrice) / triggerPrice) * 100);
        upsidePercent = Math.max(0, ((highPrice - triggerPrice) / triggerPrice) * 100);
      }
      drawdowns.push(downsidePercent);
      upsides.push(upsidePercent);
    }

    // Trade Simulation for Metrics Analysis (only if tradeAmount > 0)
    if (tradeAmount && tradeAmount > 0) {
      const qty = tradeAmount / triggerPrice;
      
      const nextTpCloseSignal = !tpCustomExpr ? safeTpCloseSignals.find(cs => cs.index > signal.index) : null;
      const nextSlCloseSignal = !slCustomExpr ? safeSlCloseSignals.find(cs => cs.index > signal.index) : null;
      
      let exitPrice = null;
      let tradeMaxDrawdown = 0;
      let tradeClosed = false;

      // Define TP / SL absolute prices
      const tpPrice = isShort 
        ? triggerPrice * (1 - tpPercent / 100) 
        : triggerPrice * (1 + tpPercent / 100);
        
      const slPrice = isShort 
        ? triggerPrice * (1 + slPercent / 100) 
        : triggerPrice * (1 - slPercent / 100);

      for (let k = signal.index + 1; k <= endIndex; k++) {
        const s = snapshots1m[k];
        const sLow = Number.isFinite(s.low) ? s.low : s.price;
        const sHigh = Number.isFinite(s.high) ? s.high : s.price;
        const currentPrice = s.price;

        // Track max drawdown
        let drawdown = 0;
        if (isShort) {
          drawdown = ((sHigh - triggerPrice) / triggerPrice) * 100;
        } else {
          drawdown = ((triggerPrice - sLow) / triggerPrice) * 100;
        }
        tradeMaxDrawdown = Math.max(tradeMaxDrawdown, Math.max(0, drawdown));

        // Check SL Percent
        if (slMode === 'percent') {
          let slHit = false;
          if (isShort) {
            if (sHigh >= slPrice) slHit = true;
          } else {
            if (sLow <= slPrice) slHit = true;
          }
          if (slHit) {
            exitPrice = slPrice;
            tradeClosed = true;
          }
        }

        // Check TP Percent
        if (!tradeClosed && tpMode === 'percent') {
          let tpHit = false;
          if (isShort) {
            if (sLow <= tpPrice) tpHit = true;
          } else {
            if (sHigh >= tpPrice) tpHit = true;
          }
          if (tpHit) {
            exitPrice = tpPrice;
            tradeClosed = true;
          }
        }

        // Evaluate Exit Signals for metrics analysis
        let exitSignalTriggered = false;
        let exitSignalPrice = null;
        
        if (tpMode === 'metric') {
          if (tpCustomExpr) {
            if (evaluateExpression(s, tpCustomExpr)) {
              exitSignalTriggered = true;
              exitSignalPrice = s.price;
            }
          } else if (nextTpCloseSignal && k >= nextTpCloseSignal.index) {
            exitSignalTriggered = true;
            exitSignalPrice = nextTpCloseSignal.price;
          }
        }
        
        if (!exitSignalTriggered && slMode === 'metric') {
          if (slCustomExpr) {
            if (evaluateExpression(s, slCustomExpr)) {
              exitSignalTriggered = true;
              exitSignalPrice = s.price;
            }
          } else if (nextSlCloseSignal && k >= nextSlCloseSignal.index) {
            exitSignalTriggered = true;
            exitSignalPrice = nextSlCloseSignal.price;
          }
        }

        // Check Close Metric Crossover Exit
        if (!tradeClosed && exitSignalTriggered) {
          exitPrice = exitSignalPrice;
          tradeClosed = true;
        }

        // Check if trade closed or reached end of 24h window
        if (tradeClosed) {
          break;
        }
        
        if (k === endIndex) {
          exitPrice = currentPrice;
          tradeClosed = true;
          break;
        }
      }

      if (exitPrice !== null) {
        const profit = isShort 
          ? qty * (triggerPrice - exitPrice)
          : qty * (exitPrice - triggerPrice);
        metricTrades.push({
          profit,
          maxDrawdown: tradeMaxDrawdown
        });
      }
    }
  }

  let tradingStats = null;
  if (tradeAmount && tradeAmount > 0 && metricTrades.length > 0) {
    const totalTrades = metricTrades.length;
    const winningTradeObjects = metricTrades.filter(t => t.profit > 0);
    const losingTradeObjects = metricTrades.filter(t => t.profit < 0);
    
    const totalWinsCount = winningTradeObjects.length;
    const totalLossesCount = losingTradeObjects.length;
    const winRate = totalTrades > 0 ? (totalWinsCount / totalTrades) * 100 : 0;
    const netProfit = metricTrades.reduce((sum, t) => sum + t.profit, 0);
    
    const grossProfit = winningTradeObjects.reduce((sum, t) => sum + t.profit, 0);
    const grossLoss = Math.abs(losingTradeObjects.reduce((sum, t) => sum + t.profit, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
    
    const avgWin = totalWinsCount > 0 ? grossProfit / totalWinsCount : 0;
    const avgLoss = totalLossesCount > 0 ? grossLoss / totalLossesCount : 0;
    
    const maxWin = totalWinsCount > 0 ? Math.max(...winningTradeObjects.map(t => t.profit)) : 0;
    const maxLoss = totalLossesCount > 0 ? Math.max(...losingTradeObjects.map(t => Math.abs(t.profit))) : 0;
    
    tradingStats = {
      totalTrades,
      winRate,
      netProfit,
      profitFactor,
      avgWin,
      avgLoss,
      maxWin,
      maxLoss,
      totalWinsCount,
      totalLossesCount
    };
  }

  return {
    drawdownMax: drawdowns.length > 0 ? Math.max(...drawdowns) : 0,
    drawdownAvg: averageValues(drawdowns),
    drawdownMed: medianValues(drawdowns),
    upsideMax: upsides.length > 0 ? Math.max(...upsides) : 0,
    upsideAvg: averageValues(upsides),
    upsideMed: medianValues(upsides),
    markers,
    tradingStats
  };
}

function averageValues(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((sum, v) => sum + v, 0) / arr.length;
}

function medianValues(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) {
    return sorted[half];
  }
  return (sorted[half - 1] + sorted[half]) / 2;
}

function renderTradingResults(results) {
  document.getElementById('backtestTradingResults').classList.remove('hidden');
  document.getElementById('backtestMetricsResults').classList.add('hidden');
  
  document.getElementById('statTotalTrades').textContent = results.totalTrades;
  document.getElementById('statWinRate').textContent = `${results.winRate.toFixed(2)}%`;
  
  const profitEl = document.getElementById('statNetProfit');
  profitEl.textContent = `$${results.netProfit.toFixed(2)}`;
  if (results.netProfit >= 0) {
    profitEl.style.color = 'var(--green)';
  } else {
    profitEl.style.color = 'var(--red)';
  }
  
  document.getElementById('statMaxDrawdown').textContent = `${results.maxDrawdown.toFixed(2)}%`;
  
  // New metrics
  document.getElementById('statProfitFactor').textContent = Number.isFinite(results.profitFactor) ? results.profitFactor.toFixed(2) : (results.profitFactor === Infinity ? '∞' : '0.00');
  document.getElementById('statAvgWinLoss').textContent = `$${results.avgWin.toFixed(2)} / $${results.avgLoss.toFixed(2)}`;
  document.getElementById('statMaxWinLoss').textContent = `$${results.maxWin.toFixed(2)} / $${results.maxLoss.toFixed(2)}`;
  document.getElementById('statWinLossCount').textContent = `${results.totalWinsCount} / ${results.totalLossesCount}`;
  
  priceSeries.setMarkers(results.markers);
}

function renderMetricsResults(results) {
  document.getElementById('backtestTradingResults').classList.add('hidden');
  document.getElementById('backtestMetricsResults').classList.remove('hidden');
  
  document.getElementById('statDrawdownMax').textContent = `${results.drawdownMax.toFixed(2)}%`;
  document.getElementById('statDrawdownAvg').textContent = `${results.drawdownAvg.toFixed(2)}%`;
  document.getElementById('statDrawdownMed').textContent = `${results.drawdownMed.toFixed(2)}%`;
  
  document.getElementById('statUpsideMax').textContent = `${results.upsideMax.toFixed(2)}%`;
  document.getElementById('statUpsideAvg').textContent = `${results.upsideAvg.toFixed(2)}%`;
  document.getElementById('statUpsideMed').textContent = `${results.upsideMed.toFixed(2)}%`;
  
  const metricsTradingStatsBlock = document.getElementById('metricsTradingStatsBlock');
  if (metricsTradingStatsBlock) {
    if (results.tradingStats) {
      metricsTradingStatsBlock.classList.remove('hidden');
      document.getElementById('metricsStatTotalTrades').textContent = results.tradingStats.totalTrades;
      document.getElementById('metricsStatWinRate').textContent = `${results.tradingStats.winRate.toFixed(2)}%`;
      
      const profitEl = document.getElementById('metricsStatNetProfit');
      profitEl.textContent = `$${results.tradingStats.netProfit.toFixed(2)}`;
      profitEl.style.color = results.tradingStats.netProfit >= 0 ? 'var(--green)' : 'var(--red)';
      
      // New metrics
      document.getElementById('metricsStatProfitFactor').textContent = Number.isFinite(results.tradingStats.profitFactor) ? results.tradingStats.profitFactor.toFixed(2) : (results.tradingStats.profitFactor === Infinity ? '∞' : '0.00');
      document.getElementById('metricsStatAvgWinLoss').textContent = `$${results.tradingStats.avgWin.toFixed(2)} / $${results.tradingStats.avgLoss.toFixed(2)}`;
      document.getElementById('metricsStatMaxWinLoss').textContent = `$${results.tradingStats.maxWin.toFixed(2)} / $${results.tradingStats.maxLoss.toFixed(2)}`;
      document.getElementById('metricsStatWinLossCount').textContent = `${results.tradingStats.totalWinsCount} / ${results.tradingStats.totalLossesCount}`;
    } else {
      metricsTradingStatsBlock.classList.add('hidden');
    }
  }
  
  priceSeries.setMarkers(results.markers);
}

// --- Live Auto Trading Configurators and Handlers ---

let autoTradeStatusIntervalId = null;
let currentStrategies = [];
let editingStrategyId = null;
let currentWallets = [];
let editingWalletId = null;
let lastTradeHistory = [];
let lastActivePositions = [];
let lastCurrentPrice = 0;
const HIBACHI_MANAGED_PRIVATE_KEY_LENGTH = 44;
const HIBACHI_TRUSTLESS_PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

function isValidHibachiSigningKey(privateKey) {
  const trimmed = String(privateKey || '').trim();
  return trimmed.length === HIBACHI_MANAGED_PRIVATE_KEY_LENGTH || HIBACHI_TRUSTLESS_PRIVATE_KEY_PATTERN.test(trimmed);
}

function applyWalletExchangeFieldState(exchangeType) {
  const groupAddress = document.getElementById('walletGroupAddress');
  const groupPrivateKey = document.getElementById('walletGroupPrivateKey');
  const groupApiKey = document.getElementById('walletGroupApiKey');
  const groupAccountId = document.getElementById('walletGroupAccountId');
  const groupApiSecret = document.getElementById('walletGroupApiSecret');
  const walletAddressInput = document.getElementById('walletAddressInput');
  const walletPrivateKeyInput = document.getElementById('walletPrivateKeyInput');
  const walletApiKeyInput = document.getElementById('walletApiKeyInput');
  const walletAccountIdInput = document.getElementById('walletAccountIdInput');
  const lblWalletPrivateKey = document.getElementById('lblWalletPrivateKey');
  const lblWalletApiKey = document.getElementById('lblWalletApiKey');
  const lang = localStorage.getItem('hype_twap_lang') || 'en';
  const t = TRANSLATIONS[lang] || TRANSLATIONS.en;

  if (lblWalletPrivateKey) lblWalletPrivateKey.textContent = t.walletPrivateKey;
  if (lblWalletApiKey) lblWalletApiKey.textContent = t.walletApiKey;

  if (exchangeType === 'hl_solana') {
    if (groupAddress) groupAddress.classList.remove('hidden');
    if (groupPrivateKey) groupPrivateKey.classList.remove('hidden');
    if (groupApiKey) groupApiKey.classList.add('hidden');
    if (groupAccountId) groupAccountId.classList.add('hidden');
    if (groupApiSecret) groupApiSecret.classList.add('hidden');
    if (walletAddressInput) walletAddressInput.placeholder = 'Solana address (base58)';
    if (walletPrivateKeyInput) walletPrivateKeyInput.placeholder = 'Solana secret key (base58 or JSON array)';
  } else if (exchangeType === 'hibachi_ccxt') {
    if (groupAddress) groupAddress.classList.add('hidden');
    if (groupPrivateKey) groupPrivateKey.classList.remove('hidden');
    if (groupApiKey) groupApiKey.classList.remove('hidden');
    if (groupAccountId) groupAccountId.classList.remove('hidden');
    if (groupApiSecret) groupApiSecret.classList.add('hidden');
    if (lblWalletPrivateKey) lblWalletPrivateKey.textContent = 'Hibachi API / Signing Private Key';
    if (lblWalletApiKey) lblWalletApiKey.textContent = 'Hibachi API Key';
    if (walletPrivateKeyInput) walletPrivateKeyInput.placeholder = '44-char API signing key or 0x trustless private key';
    if (walletApiKeyInput) walletApiKeyInput.placeholder = 'Hibachi API key...';
    if (walletAccountIdInput) walletAccountIdInput.placeholder = 'Hibachi account ID / subaccount...';
  } else {
    if (groupAddress) groupAddress.classList.add('hidden');
    if (groupPrivateKey) groupPrivateKey.classList.add('hidden');
    if (groupApiKey) groupApiKey.classList.remove('hidden');
    if (groupAccountId) groupAccountId.classList.add('hidden');
    if (groupApiSecret) groupApiSecret.classList.remove('hidden');
    if (walletApiKeyInput) walletApiKeyInput.placeholder = 'API Key...';
  }
}

function initAutoTradingConfigurator() {
  const tabAutoTrading = document.getElementById('tabAutoTrading');
  const tabContentAutoTrading = document.getElementById('tabContentAutoTrading');
  const autoTradingForm = document.getElementById('autoTradingForm');
  const autoTradeExchange = document.getElementById('autoTradeExchange');
  const autoTradeOrderCount = document.getElementById('autoTradeOrderCount');
  const autoTradeTpMode = document.getElementById('autoTradeTpMode');
  const autoTradeSlMode = document.getElementById('autoTradeSlMode');
  
  const autoTradeTpCloseSelect = document.getElementById('autoTradeTpCloseSelect');
  const autoTradeTpCloseCustomContainer = document.getElementById('autoTradeTpCloseCustomContainer');
  const autoTradeSlCloseSelect = document.getElementById('autoTradeSlCloseSelect');
  const autoTradeSlCloseCustomContainer = document.getElementById('autoTradeSlCloseCustomContainer');

  // Wallet form inputs and toggles
  const walletExchangeSelect = document.getElementById('walletExchangeSelect');
  const walletForm = document.getElementById('walletForm');

  const updateWalletExchangeFields = () => {
    const exchangeType = walletExchangeSelect.value;
    applyWalletExchangeFieldState(exchangeType);
  };

  if (walletExchangeSelect) {
    walletExchangeSelect.addEventListener('change', updateWalletExchangeFields);
  }

  // Add Wallet Button
  const createWalletBtn = document.getElementById('createWalletBtn');
  if (createWalletBtn) {
    createWalletBtn.addEventListener('click', () => {
      editingWalletId = null;
      document.getElementById('walletNameInput').value = '';
      document.getElementById('walletAddressInput').value = '';
      document.getElementById('walletPrivateKeyInput').value = '';
      document.getElementById('walletApiKeyInput').value = '';
      const walletAccountIdInput = document.getElementById('walletAccountIdInput');
      if (walletAccountIdInput) walletAccountIdInput.value = '';
      document.getElementById('walletApiSecretInput').value = '';
      walletExchangeSelect.value = 'hl_solana';
      updateWalletExchangeFields();
      
      const lang = localStorage.getItem('hype_twap_lang') || 'en';
      document.getElementById('walletFormTitle').textContent = lang === 'en' ? 'Add Wallet / API Credentials' : 'Добавить кошелек / API ключи';
      
      const feedback = document.getElementById('walletFeedback');
      if (feedback) {
        feedback.textContent = '';
        feedback.className = 'feedback-msg';
      }
      walletForm.classList.remove('hidden');
    });
  }

  // Cancel Wallet Button
  const btnCancelWallet = document.getElementById('btnCancelWallet');
  if (btnCancelWallet) {
    btnCancelWallet.addEventListener('click', () => {
      walletForm.classList.add('hidden');
      editingWalletId = null;
    });
  }

  if (walletForm) {
    walletForm.addEventListener('submit', saveWallet);
  }

  // TP/SL toggling
  const autoTradeTpPercentGroup = document.getElementById('autoTradeTpPercentGroup');
  const autoTradeTpCloseGroup = document.getElementById('autoTradeTpCloseGroup');
  const autoTradeSlPercentGroup = document.getElementById('autoTradeSlPercentGroup');
  const autoTradeSlCloseGroup = document.getElementById('autoTradeSlCloseGroup');

  const updateExitFields = () => {
    if (autoTradeTpMode) {
      if (autoTradeTpMode.value === 'percent') {
        if (autoTradeTpPercentGroup) autoTradeTpPercentGroup.classList.remove('hidden');
        if (autoTradeTpCloseGroup) autoTradeTpCloseGroup.classList.add('hidden');
      } else {
        if (autoTradeTpPercentGroup) autoTradeTpPercentGroup.classList.add('hidden');
        if (autoTradeTpCloseGroup) autoTradeTpCloseGroup.classList.remove('hidden');
      }
    }

    if (autoTradeSlMode) {
      if (autoTradeSlMode.value === 'none') {
        if (autoTradeSlPercentGroup) autoTradeSlPercentGroup.classList.add('hidden');
        if (autoTradeSlCloseGroup) autoTradeSlCloseGroup.classList.add('hidden');
      } else if (autoTradeSlMode.value === 'percent') {
        if (autoTradeSlPercentGroup) autoTradeSlPercentGroup.classList.remove('hidden');
        if (autoTradeSlCloseGroup) autoTradeSlCloseGroup.classList.add('hidden');
      } else {
        if (autoTradeSlPercentGroup) autoTradeSlPercentGroup.classList.add('hidden');
        if (autoTradeSlCloseGroup) autoTradeSlCloseGroup.classList.remove('hidden');
      }
    }
  };

  if (autoTradeTpMode) autoTradeTpMode.addEventListener('change', updateExitFields);
  if (autoTradeSlMode) autoTradeSlMode.addEventListener('change', updateExitFields);

  const autoTradeSubaccountGroup = document.getElementById('autoTradeSubaccountGroup');
  const updateExchangeFields = () => {
    if (autoTradeExchange && autoTradeSubaccountGroup) {
      if (autoTradeExchange.value === '01_exchange' || autoTradeExchange.value === 'hibachi') {
        autoTradeSubaccountGroup.classList.remove('hidden');
        updateSubaccountDropdown();
      } else {
        autoTradeSubaccountGroup.classList.add('hidden');
      }
    }
  };
  if (autoTradeExchange) {
    autoTradeExchange.addEventListener('change', updateExchangeFields);
  }

  const strategyWalletSelect = document.getElementById('strategyWalletSelect');
  if (strategyWalletSelect) {
    strategyWalletSelect.addEventListener('change', () => updateSubaccountDropdown());
  }

  const autoTradeTestnet = document.getElementById('autoTradeTestnet');
  if (autoTradeTestnet) {
    autoTradeTestnet.addEventListener('change', () => updateSubaccountDropdown());
  }

  // Custom Exits toggles
  if (autoTradeTpCloseSelect) {
    autoTradeTpCloseSelect.addEventListener('change', () => {
      if (autoTradeTpCloseSelect.value === 'custom') {
        if (autoTradeTpCloseCustomContainer) {
          autoTradeTpCloseCustomContainer.classList.remove('hidden');
          if (autoTradeTpCloseCustomContainer.children.length === 0) {
            createExitsConditionRow('autoTradeTpCloseCustomContainer');
          }
        }
      } else {
        if (autoTradeTpCloseCustomContainer) autoTradeTpCloseCustomContainer.classList.add('hidden');
      }
    });
  }

  if (autoTradeSlCloseSelect) {
    autoTradeSlCloseSelect.addEventListener('change', () => {
      if (autoTradeSlCloseSelect.value === 'custom') {
        if (autoTradeSlCloseCustomContainer) {
          autoTradeSlCloseCustomContainer.classList.remove('hidden');
          if (autoTradeSlCloseCustomContainer.children.length === 0) {
            createExitsConditionRow('autoTradeSlCloseCustomContainer');
          }
        }
      } else {
        if (autoTradeSlCloseCustomContainer) autoTradeSlCloseCustomContainer.classList.add('hidden');
      }
    });
  }

  // Limit Order leg visibility
  if (autoTradeOrderCount) {
    autoTradeOrderCount.addEventListener('change', () => {
      const count = parseInt(autoTradeOrderCount.value) || 3;
      const legRows = document.querySelectorAll('.auto-leg-row');
      legRows.forEach(row => {
        const legNum = parseInt(row.dataset.leg);
        if (legNum <= count) {
          row.style.display = 'grid';
        } else {
          row.style.display = 'none';
        }
      });
    });
  }

  // Tab switching
  if (tabAutoTrading) {
    tabAutoTrading.addEventListener('click', () => {
      tabAutoTrading.classList.add('active');
      alertElements.tabActiveAlerts.classList.remove('active');
      alertElements.tabCreateAlert.classList.remove('active');
      if (alertElements.tabBacktest) alertElements.tabBacktest.classList.remove('active');

      if (tabContentAutoTrading) tabContentAutoTrading.classList.remove('hidden');
      alertElements.tabContentList.classList.add('hidden');
      alertElements.tabContentForm.classList.add('hidden');
      if (alertElements.tabContentBacktest) alertElements.tabContentBacktest.classList.add('hidden');

      populateAutoTradeAlertSelect();
      populateAutoTradeCloseAlertSelect();
      loadAutoTradeConfig();

      // Trigger field update visibility state
      updateExitFields();
      if (autoTradeOrderCount) autoTradeOrderCount.dispatchEvent(new Event('change'));

      // Start Polling Status
      if (!autoTradeStatusIntervalId) {
        refreshAutoTradeStatus();
        autoTradeStatusIntervalId = setInterval(refreshAutoTradeStatus, 3000);
      }
    });
  }

  // Clear interval when switching tabs away from Auto Trading
  const otherTabs = [alertElements.tabActiveAlerts, alertElements.tabCreateAlert, alertElements.tabBacktest];
  otherTabs.forEach(tab => {
    if (tab) {
      tab.addEventListener('click', () => {
        if (autoTradeStatusIntervalId) {
          clearInterval(autoTradeStatusIntervalId);
          autoTradeStatusIntervalId = null;
        }
      });
    }
  });

  // Create Strategy Button
  const createStrategyBtn = document.getElementById('createStrategyBtn');
  if (createStrategyBtn) {
    createStrategyBtn.addEventListener('click', () => {
      editingStrategyId = null;
      resetStrategyForm();
      const lang = localStorage.getItem('hype_twap_lang') || 'en';
      const formTitle = document.getElementById('strategyFormTitle');
      if (formTitle) formTitle.textContent = lang === 'en' ? 'Create Strategy' : 'Создать стратегию';
      autoTradingForm.classList.remove('hidden');
    });
  }

  // Cancel Button
  const btnCancelAutoTrade = document.getElementById('btnCancelAutoTrade');
  if (btnCancelAutoTrade) {
    btnCancelAutoTrade.addEventListener('click', () => {
      autoTradingForm.classList.add('hidden');
      editingStrategyId = null;
    });
  }

  if (autoTradingForm) {
    autoTradingForm.addEventListener('submit', saveAutoTradeConfig);
  }
}

function resetStrategyForm() {
  document.getElementById('strategyNameInput').value = '';
  document.getElementById('autoTradeEnabled').checked = true;
  document.getElementById('autoTradeExchange').value = 'hl';
  document.getElementById('autoTradeTestnet').checked = true;
  document.getElementById('autoTradeAlertSelect').value = '';
  document.getElementById('autoTradeDirection').value = 'auto';
  document.getElementById('autoTradeOrderCount').value = '3';
  document.getElementById('autoTradeOrderCount').dispatchEvent(new Event('change'));
  document.getElementById('autoTradeAmount').value = '60';
  document.getElementById('autoTradeUnfilledCancelMinutes').value = '30';

  document.getElementById('autoTradeSubaccountIndex').value = '0';
  const autoTradeSubaccountGroup = document.getElementById('autoTradeSubaccountGroup');
  if (autoTradeSubaccountGroup) autoTradeSubaccountGroup.classList.add('hidden');

  populateStrategyWalletSelect();
  document.getElementById('strategyWalletSelect').value = '';

  // legs
  for (let i = 1; i <= 3; i++) {
    document.getElementById(`autoTradeOffset${i}`).value = i === 1 ? '-0.3' : i === 2 ? '-1.0' : '-2.0';
    document.getElementById(`autoTradeAmount${i}`).value = i === 1 ? '10' : i === 2 ? '20' : '30';
  }

  document.getElementById('autoTradeTpMode').value = 'percent';
  document.getElementById('autoTradeTpMode').dispatchEvent(new Event('change'));
  document.getElementById('autoTradeTpPercent').value = '1.5';
  document.getElementById('autoTradeTpAnchor').value = 'avg';
  document.getElementById('autoTradeTpCloseSelect').value = 'same';
  document.getElementById('autoTradeTpCloseSelect').dispatchEvent(new Event('change'));
  const tpCustomContainer = document.getElementById('autoTradeTpCloseCustomContainer');
  if (tpCustomContainer) tpCustomContainer.innerHTML = '';

  document.getElementById('autoTradeSlMode').value = 'none';
  document.getElementById('autoTradeSlMode').dispatchEvent(new Event('change'));
  document.getElementById('autoTradeSlPercent').value = '2.0';
  document.getElementById('autoTradeSlCloseSelect').value = 'same';
  document.getElementById('autoTradeSlCloseSelect').dispatchEvent(new Event('change'));
  const slCustomContainer = document.getElementById('autoTradeSlCloseCustomContainer');
  if (slCustomContainer) slCustomContainer.innerHTML = '';

  const feedback = document.getElementById('autoTradeFeedback');
  if (feedback) {
    feedback.textContent = '';
    feedback.className = 'feedback-msg';
  }
}

function populateAutoTradeAlertSelect() {
  const select = document.getElementById('autoTradeAlertSelect');
  if (!select) return;
  
  const currentVal = select.value;
  select.innerHTML = '';
  
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.disabled = true;
  defaultOpt.selected = !currentVal;
  const currentLang = localStorage.getItem('hype_twap_lang') || 'en';
  defaultOpt.textContent = currentLang === 'en' ? 'Select Alert...' : 'Выберите алерт...';
  select.appendChild(defaultOpt);
  
  cachedAlerts.forEach(alert => {
    const opt = document.createElement('option');
    opt.value = alert.id;
    opt.textContent = `${alert.name} (${alert.timeframe || '1m'})`;
    if (alert.id === currentVal) {
      opt.selected = true;
    }
    select.appendChild(opt);
  });
}

function populateAutoTradeCloseAlertSelect() {
  const tpSelect = document.getElementById('autoTradeTpCloseSelect');
  const slSelect = document.getElementById('autoTradeSlCloseSelect');
  const currentLang = localStorage.getItem('hype_twap_lang') || 'en';
  
  const populate = (select) => {
    if (!select) return;
    const currentVal = select.value;
    select.innerHTML = '';
    
    const sameOpt = document.createElement('option');
    sameOpt.value = 'same';
    sameOpt.textContent = currentLang === 'en' ? 'Same as Signal Alert' : 'По умолчанию (текущий)';
    sameOpt.selected = !currentVal || currentVal === 'same';
    select.appendChild(sameOpt);
    
    const customOpt = document.createElement('option');
    customOpt.value = 'custom';
    customOpt.textContent = currentLang === 'en' ? 'Custom Condition...' : 'Своё условие...';
    customOpt.selected = currentVal === 'custom';
    select.appendChild(customOpt);
    
    cachedAlerts.forEach(alert => {
      const opt = document.createElement('option');
      opt.value = alert.id;
      opt.textContent = `${alert.name} (${alert.timeframe || '1m'})`;
      if (alert.id === currentVal) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });
  };

  populate(tpSelect);
  populate(slSelect);
}

async function loadAutoTradeConfig() {
  try {
    const response = await fetch('/api/autotrade/config');
    if (!response.ok) return;
    const config = await response.json();
    if (!config) return;

    currentStrategies = config.strategies || [];
    currentWallets = config.wallets || [];
    
    renderStrategiesList();
    renderWalletsList();
    populateStrategyWalletSelect();
  } catch (err) {
    console.error('Error loading auto-trading config:', err);
  }
}

function renderStrategiesList() {
  const container = document.getElementById('strategiesList');
  if (!container) return;
  container.innerHTML = '';

  const lang = localStorage.getItem('hype_twap_lang') || 'en';

  if (currentStrategies.length === 0) {
    container.innerHTML = `<p class="placeholder-text">${lang === 'en' ? 'No strategies configured yet.' : 'Стратегии не настроены.'}</p>`;
    return;
  }

  currentStrategies.forEach(strategy => {
    const item = document.createElement('div');
    item.className = 'alert-item';

    const exchangeName = strategy.exchange === 'hl' ? 'Hyperliquid' : (strategy.exchange === 'bybit' ? 'Bybit' : (strategy.exchange === 'hibachi' ? 'Hibachi' : '01 Exchange'));
    const netType = strategy.testnet ? '(Testnet)' : '(Mainnet)';
    const subaccountSuffix = (strategy.exchange === '01_exchange' || strategy.exchange === 'hibachi') ? ` [Sub #${strategy.subaccountIndex ?? 0}]` : '';
    const amountStr = strategy.tradeAmount ? `$${strategy.tradeAmount}` : 'Grid';
    
    // Find alert name
    let alertName = '';
    const alert = cachedAlerts.find(a => a.id === strategy.alertId);
    if (alert) {
      alertName = `${alert.name} (${alert.timeframe || '1m'})`;
    } else {
      alertName = strategy.alertId ? `Alert ID: ${strategy.alertId}` : 'None';
    }

    // Find wallet name
    let walletLabel = '';
    if (strategy.walletId) {
      const wallet = currentWallets.find(w => w.id === strategy.walletId);
      walletLabel = wallet ? ` | 💼 ${wallet.name}` : ' | 💼 (Deleted)';
    }

    let directionStr = 'Auto';
    let directionColor = 'var(--amber)';
    if (strategy.direction === 'long') {
      directionStr = 'Long';
      directionColor = '#35d083';
    } else if (strategy.direction === 'short') {
      directionStr = 'Short';
      directionColor = '#ef5e5e';
    } else if (strategy.direction === 'trend_long') {
      directionStr = 'Trend Long';
      directionColor = '#35d083';
    } else if (strategy.direction === 'trend_short') {
      directionStr = 'Trend Short';
      directionColor = '#ef5e5e';
    }
    const directionBadge = ` <span style="color: ${directionColor}; background: rgba(255,255,255,0.05); padding: 1px 4px; border-radius: 3px; font-size: 9px; margin-left: 4px;">${directionStr}</span>`;

    // Compute strategy metrics
    const balance = strategy.balance ?? 0;
    
    // Realized PnL
    const completed = lastTradeHistory.filter(t => t.strategyId === strategy.id);
    const realized = completed.reduce((sum, t) => sum + (t.profit || 0), 0);

    // Unrealized PnL
    const active = lastActivePositions.filter(p => p.strategyId === strategy.id);
    let unrealized = 0;
    active.forEach(p => {
      const qty = p.qty || 0;
      const avgPrice = p.avgPrice || 0;
      if (qty > 0) {
        const isShort = p.direction === 'short';
        const diff = isShort ? (avgPrice - lastCurrentPrice) : (lastCurrentPrice - avgPrice);
        unrealized += qty * diff;
      }
    });

    const totalPnl = realized + unrealized;
    const pnlSign = totalPnl >= 0 ? '+' : '';
    const pnlStyle = totalPnl >= 0 ? 'color: var(--green);' : 'color: var(--red);';

    // Winrate
    const closedTrades = completed.filter(t => t.status === 'closed');
    const winningTrades = closedTrades.filter(t => (t.profit || 0) > 0);
    const winrate = closedTrades.length > 0 ? (winningTrades.length / closedTrades.length) * 100 : 0;

    const balanceLbl = lang === 'en' ? 'Balance' : 'Баланс';
    const pnlLbl = lang === 'en' ? 'PnL' : 'ПнЛ';
    const winrateLbl = lang === 'en' ? 'Winrate' : 'Винрейт';

    item.innerHTML = `
      <div class="alert-info" style="flex: 1; min-width: 0;">
        <span class="alert-title">${strategy.name || 'Unnamed Strategy'}${directionBadge}</span>
        <span class="alert-rule">${exchangeName}${subaccountSuffix} ${netType}${walletLabel} | ${lang === 'en' ? 'Trigger' : 'Триггер'}: ${alertName} | ${lang === 'en' ? 'Size' : 'Объем'}: ${amountStr}</span>
        <div class="strategy-stats" style="margin-top: 8px; font-size: 11px; display: flex; flex-wrap: wrap; gap: 14px; padding-top: 6px; border-top: 1px dashed rgba(255,255,255,0.08);">
          <span style="display: inline-flex; align-items: center; gap: 4px; color: var(--muted);">
            💰 ${balanceLbl}: <strong style="color: var(--text); font-family: monospace;">$${balance.toFixed(2)}</strong>
          </span>
          <span style="display: inline-flex; align-items: center; gap: 4px; color: var(--muted);">
            📈 ${pnlLbl}: <strong style="${pnlStyle} font-family: monospace;">${pnlSign}$${totalPnl.toFixed(2)}</strong>
          </span>
          <span style="display: inline-flex; align-items: center; gap: 4px; color: var(--muted);">
            🎯 ${winrateLbl}: <strong style="color: var(--text); font-family: monospace;">${winrate.toFixed(1)}%</strong>
          </span>
        </div>
      </div>
      <div class="alert-actions">
        <label class="switch">
          <input type="checkbox" class="toggle-strategy-active" data-id="${strategy.id}" ${strategy.enabled ? 'checked' : ''}/>
          <span class="slider"></span>
        </label>
        <button class="edit-strategy-btn" data-id="${strategy.id}" title="${lang === 'en' ? 'Edit Strategy' : 'Редактировать стратегию'}" type="button">✏️</button>
        <button class="delete-strategy-btn" data-id="${strategy.id}" title="${lang === 'en' ? 'Delete Strategy' : 'Удалить стратегию'}" type="button">×</button>
      </div>
    `;

    // Toggle active event listener
    item.querySelector('.slider').addEventListener('click', async (e) => {
      e.preventDefault();
      const checkbox = item.querySelector('.toggle-strategy-active');
      const isEnabledNow = !checkbox.checked;
      checkbox.checked = isEnabledNow;
      
      // Update local strategy
      strategy.enabled = isEnabledNow;
      await saveAllStrategiesSilent();
    });

    // Edit event listener
    item.querySelector('.edit-strategy-btn').addEventListener('click', () => {
      startEditStrategy(strategy);
    });

    // Delete event listener
    item.querySelector('.delete-strategy-btn').addEventListener('click', async () => {
      const confirmMsg = lang === 'en' 
        ? `Are you sure you want to delete strategy "${strategy.name}"?` 
        : `Вы уверены, что хотите удалить стратегию "${strategy.name}"?`;
      if (confirm(confirmMsg)) {
        currentStrategies = currentStrategies.filter(s => s.id !== strategy.id);
        await saveAllStrategiesSilent();
      }
    });

    container.appendChild(item);
  });
}

async function saveAllStrategiesSilent() {
  await saveConfigToServer();
  renderStrategiesList();
}

function startEditStrategy(strategy) {
  editingStrategyId = strategy.id;
  const form = document.getElementById('autoTradingForm');
  if (!form) return;

  const lang = localStorage.getItem('hype_twap_lang') || 'en';
  const formTitle = document.getElementById('strategyFormTitle');
  if (formTitle) formTitle.textContent = lang === 'en' ? 'Edit Strategy' : 'Редактировать стратегию';

  // Populate fields
  document.getElementById('strategyNameInput').value = strategy.name || '';
  document.getElementById('autoTradeEnabled').checked = !!strategy.enabled;
  document.getElementById('autoTradeExchange').value = strategy.exchange || 'hl';
  document.getElementById('autoTradeTestnet').checked = !!strategy.testnet;

  populateStrategyWalletSelect();
  document.getElementById('strategyWalletSelect').value = strategy.walletId || '';

  const subaccountIndexVal = strategy.subaccountIndex || 0;
  const autoTradeSubaccountGroup = document.getElementById('autoTradeSubaccountGroup');
  if (autoTradeSubaccountGroup) {
    if (strategy.exchange === '01_exchange' || strategy.exchange === 'hibachi') {
      autoTradeSubaccountGroup.classList.remove('hidden');
      updateSubaccountDropdown(subaccountIndexVal);
    } else {
      autoTradeSubaccountGroup.classList.add('hidden');
      updateSubaccountDropdown(0);
    }
  }

  document.getElementById('autoTradeAlertSelect').value = strategy.alertId || '';
  document.getElementById('autoTradeDirection').value = strategy.direction || 'auto';
  document.getElementById('autoTradeOrderCount').value = strategy.orderCount || '3';
  document.getElementById('autoTradeOrderCount').dispatchEvent(new Event('change'));
  document.getElementById('autoTradeAmount').value = strategy.tradeAmount || '';
  document.getElementById('autoTradeUnfilledCancelMinutes').value = strategy.unfilledCancelMinutes ?? 30;

  // Grid legs
  for (let i = 1; i <= 3; i++) {
    if (strategy[`legOffset${i}`] !== undefined) {
      document.getElementById(`autoTradeOffset${i}`).value = strategy[`legOffset${i}`];
    }
    if (strategy[`legAmount${i}`] !== undefined) {
      document.getElementById(`autoTradeAmount${i}`).value = strategy[`legAmount${i}`];
    }
  }

  // Exits config
  if (strategy.tpMode) {
    document.getElementById('autoTradeTpMode').value = strategy.tpMode;
    document.getElementById('autoTradeTpMode').dispatchEvent(new Event('change'));
  }
  if (strategy.tpPercent !== undefined) {
    document.getElementById('autoTradeTpPercent').value = strategy.tpPercent;
  }
  if (strategy.tpAnchor) {
    document.getElementById('autoTradeTpAnchor').value = strategy.tpAnchor;
  }
  if (strategy.tpCloseSelect) {
    document.getElementById('autoTradeTpCloseSelect').value = strategy.tpCloseSelect;
    document.getElementById('autoTradeTpCloseSelect').dispatchEvent(new Event('change'));
  }
  const tpCustomContainer = document.getElementById('autoTradeTpCloseCustomContainer');
  if (tpCustomContainer) tpCustomContainer.innerHTML = '';
  if (strategy.tpCustomExpr) {
    createExitsConditionRow('autoTradeTpCloseCustomContainer', strategy.tpCustomExpr);
  }

  if (strategy.slMode) {
    document.getElementById('autoTradeSlMode').value = strategy.slMode;
    document.getElementById('autoTradeSlMode').dispatchEvent(new Event('change'));
  }
  if (strategy.slPercent !== undefined) {
    document.getElementById('autoTradeSlPercent').value = strategy.slPercent;
  }
  if (strategy.slCloseSelect) {
    document.getElementById('autoTradeSlCloseSelect').value = strategy.slCloseSelect;
    document.getElementById('autoTradeSlCloseSelect').dispatchEvent(new Event('change'));
  }
  const slCustomContainer = document.getElementById('autoTradeSlCloseCustomContainer');
  if (slCustomContainer) slCustomContainer.innerHTML = '';
  if (strategy.slCustomExpr) {
    createExitsConditionRow('autoTradeSlCloseCustomContainer', strategy.slCustomExpr);
  }

  // Clear feedback message
  const feedback = document.getElementById('autoTradeFeedback');
  if (feedback) {
    feedback.textContent = '';
    feedback.className = 'feedback-msg';
  }

  // Show form
  form.classList.remove('hidden');
}

async function saveAutoTradeConfig(e) {
  e.preventDefault();
  const feedback = document.getElementById('autoTradeFeedback');
  const currentLang = localStorage.getItem('hype_twap_lang') || 'en';
  
  feedback.className = 'feedback-msg';
  feedback.textContent = currentLang === 'en' ? 'Saving strategy...' : 'Сохранение стратегии...';

  try {
    const alertId = document.getElementById('autoTradeAlertSelect').value;
    if (!alertId) {
      throw new Error(currentLang === 'en' ? 'Please select a trigger alert.' : 'Пожалуйста, выберите сигнальное оповещение.');
    }

    const walletId = document.getElementById('strategyWalletSelect').value;
    if (!walletId) {
      throw new Error(currentLang === 'en' ? 'Please select a wallet.' : 'Пожалуйста, выберите кошелек.');
    }

    const name = document.getElementById('strategyNameInput').value.trim() || 'Strategy';
    const strategyId = editingStrategyId || crypto.randomUUID();

    const strategy = {
      id: strategyId,
      name: name,
      enabled: document.getElementById('autoTradeEnabled').checked,
      exchange: document.getElementById('autoTradeExchange').value,
      testnet: document.getElementById('autoTradeTestnet').checked,
      subaccountIndex: parseInt(document.getElementById('autoTradeSubaccountIndex').value, 10) || 0,
      walletId: walletId,
      alertId: alertId,
      direction: document.getElementById('autoTradeDirection').value,
      orderCount: parseInt(document.getElementById('autoTradeOrderCount').value) || 3,
      tradeAmount: parseFloat(document.getElementById('autoTradeAmount').value) || null,
      unfilledCancelMinutes: parseFloat(document.getElementById('autoTradeUnfilledCancelMinutes').value) ?? 30,
      
      legOffset1: parseFloat(document.getElementById('autoTradeOffset1').value),
      legAmount1: parseFloat(document.getElementById('autoTradeAmount1').value),
      legOffset2: parseFloat(document.getElementById('autoTradeOffset2').value),
      legAmount2: parseFloat(document.getElementById('autoTradeAmount2').value),
      legOffset3: parseFloat(document.getElementById('autoTradeOffset3').value),
      legAmount3: parseFloat(document.getElementById('autoTradeAmount3').value),
      
      tpMode: document.getElementById('autoTradeTpMode').value,
      tpPercent: parseFloat(document.getElementById('autoTradeTpPercent').value) || 1.5,
      tpAnchor: document.getElementById('autoTradeTpAnchor').value,
      tpCloseSelect: document.getElementById('autoTradeTpCloseSelect').value,
      tpCustomExpr: getCustomExitCondition('autoTradeTpCloseCustomContainer'),
      
      slMode: document.getElementById('autoTradeSlMode').value,
      slPercent: parseFloat(document.getElementById('autoTradeSlPercent').value) || 2.0,
      slCloseSelect: document.getElementById('autoTradeSlCloseSelect').value,
      slCustomExpr: getCustomExitCondition('autoTradeSlCloseCustomContainer')
    };

    if (editingStrategyId) {
      // Edit existing
      const index = currentStrategies.findIndex(s => s.id === editingStrategyId);
      if (index !== -1) {
        currentStrategies[index] = strategy;
      }
    } else {
      // Add new
      currentStrategies.push(strategy);
    }

    await saveConfigToServer();

    feedback.className = 'feedback-msg success';
    feedback.textContent = currentLang === 'en' ? 'Strategy saved successfully!' : 'Стратегия сохранена!';

    // Hide form and reload config list
    document.getElementById('autoTradingForm').classList.add('hidden');
    editingStrategyId = null;
    renderStrategiesList();
  } catch (err) {
    feedback.className = 'feedback-msg error';
    feedback.textContent = err.message;
    console.error('Error saving strategy config:', err);
  }
}

// Wallets Implementation
function renderWalletsList() {
  const container = document.getElementById('walletsList');
  if (!container) return;
  container.innerHTML = '';

  const lang = localStorage.getItem('hype_twap_lang') || 'en';

  if (currentWallets.length === 0) {
    container.innerHTML = `<p class="placeholder-text">${lang === 'en' ? 'No wallets configured yet.' : 'Кошельки не настроены.'}</p>`;
    return;
  }

  currentWallets.forEach(wallet => {
    const item = document.createElement('div');
    item.className = 'alert-item';

    const exchangeTypeStr = wallet.exchangeType === 'hl_solana' ? 'Solana (Hyperliquid/01)' : (wallet.exchangeType === 'hibachi_ccxt' ? 'Hibachi.xyz (CCXT)' : 'Bybit API Keys');
    
    // Mask private keys / secrets for safety
    let keyInfo = '';
    if (wallet.exchangeType === 'hl_solana') {
      const addr = wallet.address || '';
      const displayAddr = addr.length > 10 ? (addr.substring(0, 6) + '...' + addr.substring(addr.length - 4)) : addr;
      keyInfo = `${lang === 'en' ? 'Address' : 'Адрес'}: ${displayAddr}`;
    } else if (wallet.exchangeType === 'hibachi_ccxt') {
      keyInfo = `Account ID: ${wallet.accountId || '-'}`;
    } else {
      const apiKey = wallet.apiKey || '';
      const displayKey = apiKey.length > 8 ? (apiKey.substring(0, 4) + '...' + apiKey.substring(apiKey.length - 4)) : apiKey;
      keyInfo = `API Key: ${displayKey}`;
    }

    item.innerHTML = `
      <div class="alert-info">
        <span class="alert-title">${wallet.name || 'Unnamed Wallet'} <span style="color: var(--muted); font-size: 10px; margin-left: 6px;">(${exchangeTypeStr})</span></span>
        <span class="alert-rule">${keyInfo}</span>
      </div>
      <div class="alert-actions">
        <button class="edit-wallet-btn" data-id="${wallet.id}" title="${lang === 'en' ? 'Edit Wallet' : 'Редактировать кошелек'}" type="button">✏️</button>
        <button class="delete-wallet-btn" data-id="${wallet.id}" title="${lang === 'en' ? 'Delete Wallet' : 'Удалить кошелек'}" type="button">×</button>
      </div>
    `;

    // Edit event listener
    item.querySelector('.edit-wallet-btn').addEventListener('click', () => {
      startEditWallet(wallet);
    });

    // Delete event listener
    item.querySelector('.delete-wallet-btn').addEventListener('click', async () => {
      const confirmMsg = lang === 'en' 
        ? `Are you sure you want to delete wallet "${wallet.name}"?` 
        : `Вы уверены, что хотите удалить кошелек "${wallet.name}"?`;
      if (confirm(confirmMsg)) {
        currentWallets = currentWallets.filter(w => w.id !== wallet.id);
        await saveConfigToServer();
        renderWalletsList();
        populateStrategyWalletSelect();
      }
    });

    container.appendChild(item);
  });
}

function startEditWallet(wallet) {
  editingWalletId = wallet.id;
  const form = document.getElementById('walletForm');
  if (!form) return;

  const lang = localStorage.getItem('hype_twap_lang') || 'en';
  document.getElementById('walletFormTitle').textContent = lang === 'en' ? 'Edit Wallet / API Credentials' : 'Редактировать кошелек / API ключи';

  document.getElementById('walletNameInput').value = wallet.name || '';
  document.getElementById('walletExchangeSelect').value = wallet.exchangeType || 'hl_solana';
  
  // Trigger visibility toggles
  const exchangeType = wallet.exchangeType || 'hl_solana';
  applyWalletExchangeFieldState(exchangeType);

  document.getElementById('walletAddressInput').value = wallet.address || '';
  document.getElementById('walletPrivateKeyInput').value = wallet.privateKey || '';
  document.getElementById('walletApiKeyInput').value = wallet.apiKey || '';
  const walletAccountIdInput = document.getElementById('walletAccountIdInput');
  if (walletAccountIdInput) walletAccountIdInput.value = wallet.accountId || '';
  document.getElementById('walletApiSecretInput').value = wallet.apiSecret || '';

  // Clear feedback
  const feedback = document.getElementById('walletFeedback');
  if (feedback) {
    feedback.textContent = '';
    feedback.className = 'feedback-msg';
  }

  form.classList.remove('hidden');
}

async function saveWallet(e) {
  e.preventDefault();
  const feedback = document.getElementById('walletFeedback');
  const currentLang = localStorage.getItem('hype_twap_lang') || 'en';
  
  feedback.className = 'feedback-msg';
  feedback.textContent = currentLang === 'en' ? 'Saving wallet...' : 'Сохранение кошелька...';

  try {
    const name = document.getElementById('walletNameInput').value.trim();
    if (!name) {
      throw new Error(currentLang === 'en' ? 'Please enter a wallet name.' : 'Пожалуйста, введите название кошелька.');
    }

    const exchangeType = document.getElementById('walletExchangeSelect').value;
    const address = document.getElementById('walletAddressInput').value.trim();
    const privateKey = document.getElementById('walletPrivateKeyInput').value.trim();
    const apiKey = document.getElementById('walletApiKeyInput').value.trim();
    const accountId = document.getElementById('walletAccountIdInput')?.value.trim() || '';
    const apiSecret = document.getElementById('walletApiSecretInput').value.trim();

    if (exchangeType === 'hl_solana') {
      if (!address) {
        throw new Error(currentLang === 'en' ? 'Solana wallet address is required.' : 'Solana wallet address is required.');
      }
      if (address.startsWith('0x')) {
        throw new Error(currentLang === 'en' ? '01 Exchange requires a Solana wallet address, not an EVM 0x address.' : '01 Exchange requires a Solana wallet address, not an EVM 0x address.');
      }
      if (!privateKey) {
        throw new Error(currentLang === 'en' ? 'Private Key is required.' : 'Приватный ключ обязателен.');
      }
      if (privateKey.startsWith('0x')) {
        throw new Error(currentLang === 'en' ? '01 Exchange trading requires a Solana private key. EVM private keys are not supported.' : '01 Exchange trading requires a Solana private key. EVM private keys are not supported.');
      }
    } else if (exchangeType === 'hibachi_ccxt') {
      if (!apiKey || !accountId || !privateKey) {
        throw new Error(currentLang === 'en' ? 'Hibachi API Key, Account ID, and Private Key are required.' : 'Для Hibachi нужны API Key, Account ID и Private Key.');
      }
      if (!isValidHibachiSigningKey(privateKey)) {
        throw new Error(
          currentLang === 'en'
            ? 'Hibachi Private Key must be a 44-character API signing key or a 0x-prefixed 64-hex trustless private key.'
            : 'Hibachi Private Key должен быть 44-символьным API signing key или 0x-prefixed 64-hex trustless private key.'
        );
      }
    } else {
      if (!apiKey || !apiSecret) {
        throw new Error(currentLang === 'en' ? 'API Key and Secret are required.' : 'API Ключ и Секрет обязательны.');
      }
    }

    const id = editingWalletId || crypto.randomUUID();

    const wallet = {
      id,
      name,
      exchangeType,
      address,
      privateKey,
      apiKey,
      accountId,
      apiSecret
    };

    if (editingWalletId) {
      const index = currentWallets.findIndex(w => w.id === editingWalletId);
      if (index !== -1) {
        currentWallets[index] = wallet;
      }
    } else {
      currentWallets.push(wallet);
    }

    await saveConfigToServer();

    feedback.className = 'feedback-msg success';
    feedback.textContent = currentLang === 'en' ? 'Wallet saved successfully!' : 'Кошелек сохранен!';

    document.getElementById('walletForm').classList.add('hidden');
    editingWalletId = null;
    renderWalletsList();
    populateStrategyWalletSelect();
  } catch (err) {
    feedback.className = 'feedback-msg error';
    feedback.textContent = err.message;
    console.error('Error saving wallet config:', err);
  }
}

function populateStrategyWalletSelect() {
  const select = document.getElementById('strategyWalletSelect');
  if (!select) return;
  
  const currentVal = select.value;
  select.innerHTML = '';
  
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.disabled = true;
  defaultOpt.selected = !currentVal;
  const currentLang = localStorage.getItem('hype_twap_lang') || 'en';
  defaultOpt.textContent = currentLang === 'en' ? 'Select Wallet...' : 'Выберите кошелек...';
  select.appendChild(defaultOpt);
  
  currentWallets.forEach(wallet => {
    const opt = document.createElement('option');
    opt.value = wallet.id;
    const typeLabel = wallet.exchangeType === 'hl_solana' ? 'Solana' : (wallet.exchangeType === 'hibachi_ccxt' ? 'Hibachi' : 'Bybit');
    opt.textContent = `${wallet.name} (${typeLabel})`;
    if (wallet.id === currentVal) {
      opt.selected = true;
    }
    select.appendChild(opt);
  });
}

async function updateSubaccountDropdown(selectedSubaccountIndex = 0) {
  const exchange = document.getElementById('autoTradeExchange').value;
  const walletId = document.getElementById('strategyWalletSelect').value;
  const testnet = document.getElementById('autoTradeTestnet').checked;
  const select = document.getElementById('autoTradeSubaccountIndex');
  const feedback = document.getElementById('subaccountFeedback');

  if (feedback) feedback.textContent = '';

  if (!select) return;

  if ((exchange !== '01_exchange' && exchange !== 'hibachi') || !walletId) {
    select.innerHTML = '<option value="0">Default (Subaccount #0)</option>';
    select.value = "0";
    return;
  }

  const lang = localStorage.getItem('hype_twap_lang') || 'en';
  select.innerHTML = `<option value="" disabled selected>${lang === 'en' ? 'Loading subaccounts...' : 'Загрузка субаккаунтов...'}</option>`;

  try {
    const res = await fetch(`/api/autotrade/subaccounts?walletId=${walletId}&testnet=${testnet}`);
    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || 'Failed to fetch subaccounts');
    }
    const data = await res.json();
    select.innerHTML = '';

    if (!data.subaccounts || data.subaccounts.length === 0) {
      const opt = document.createElement('option');
      opt.value = "0";
      opt.textContent = lang === 'en' ? 'No subaccounts found (Default #0)' : 'Субаккаунты не найдены (Дефолт #0)';
      select.appendChild(opt);
    } else {
      data.subaccounts.forEach(sub => {
        const opt = document.createElement('option');
        opt.value = sub.index;
        const idStr = sub.id !== undefined && sub.id !== null ? String(sub.id) : '';
        const shortId = idStr.length > 10 ? (idStr.slice(0, 6) + '...' + idStr.slice(-4)) : idStr;
        const balanceStr = (sub.balance !== undefined) ? ` — $${sub.balance.toFixed(2)} USDC` : '';
        opt.textContent = `Subaccount #${sub.index} (${shortId})${balanceStr}`;
        if (sub.index === parseInt(selectedSubaccountIndex, 10)) {
          opt.selected = true;
        }
        select.appendChild(opt);
      });
    }

    if (select.value === "") {
      select.value = selectedSubaccountIndex.toString();
    }
  } catch (err) {
    console.error('Error fetching subaccounts:', err);
    if (feedback) {
      feedback.textContent = err.message;
    }
    select.innerHTML = '';
    for (let i = 0; i < 5; i++) {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `Subaccount #${i} ${i === 0 ? '(Default)' : ''}`;
      if (i === parseInt(selectedSubaccountIndex, 10)) {
        opt.selected = true;
      }
      select.appendChild(opt);
    }
  }
}

async function saveConfigToServer() {
  try {
    const response = await fetch('/api/autotrade/config', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ strategies: currentStrategies, wallets: currentWallets })
    });
    if (!response.ok) {
      console.error('Failed to save config to server');
    }
  } catch (err) {
    console.error('Error in saveConfigToServer:', err);
  }
}

async function refreshAutoTradeStatus() {
  try {
    const response = await fetch('/api/autotrade/status');
    if (!response.ok) return;
    const data = await response.json();

    lastTradeHistory = data.tradeHistory || [];
    lastActivePositions = data.activePositions || [];
    lastCurrentPrice = data.currentPrice || 0;
    currentStrategies = data.strategies || [];
    currentWallets = data.wallets || [];
    renderStrategiesList();

    const statusDot = document.getElementById('autoTradeStatusDot');
    const statusText = document.getElementById('titleAutoTradeStatus');
    const currentLang = localStorage.getItem('hype_twap_lang') || 'en';

    if (statusDot && statusText) {
      if (data.enabled) {
        statusDot.style.background = '#35d083';
        statusText.textContent = currentLang === 'en' ? 'Bot Active' : 'Бот запущен';
      } else {
        statusDot.style.background = 'var(--muted)';
        statusText.textContent = currentLang === 'en' ? 'Bot Offline' : 'Бот выключен';
      }
    }

    // 1. Render Active Positions
    const positionsBody = document.getElementById('autoTradePositionsBody');
    if (positionsBody) {
      positionsBody.innerHTML = '';

      if (!data.activePositions || data.activePositions.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td colspan="7" style="padding: 10px; text-align: center; color: var(--muted);">${currentLang === 'en' ? 'No active positions.' : 'Нет активных позиций.'}</td>`;
        positionsBody.appendChild(tr);
      } else {
        data.activePositions.forEach(pos => {
          const entryPrice = pos.avgPrice || 0;
          const currentPrice = data.currentPrice || 0;
          const qty = pos.qty || 0;
          const direction = pos.direction || 'long';
          const isShort = (direction === 'short');

          let unrealizedPnl = 0;
          if (qty > 0) {
            unrealizedPnl = isShort ? qty * (entryPrice - currentPrice) : qty * (currentPrice - entryPrice);
          }

          const pnlStyle = unrealizedPnl >= 0 ? 'color: var(--green);' : 'color: var(--red);';
          const pnlSign = unrealizedPnl >= 0 ? '+' : '';

          const fillsCount = pos.filledPositions?.length || 0;
          const limitCount = pos.limitOrders?.length || 0;
          
          // Display Strategy & Wallet Name alongside Asset
          let walletLabel = '';
          const strategy = currentStrategies.find(s => s.id === pos.strategyId);
          if (strategy && strategy.walletId) {
            const wallet = currentWallets.find(w => w.id === strategy.walletId);
            if (wallet) {
              walletLabel = ` (${wallet.name})`;
            }
          }
          const subaccountLabel = (pos.exchange === '01_exchange' || pos.exchange === 'hibachi') ? ` [Sub #${pos.subaccountIndex ?? 0}]` : '';
          const displayName = `HYPE<br/><span style="font-size: 9px; color: var(--muted);">${pos.strategyName || 'Strategy'}${subaccountLabel}${walletLabel}</span>`;

          const tr = document.createElement('tr');
          tr.style.borderBottom = '1px solid var(--line)';
          tr.innerHTML = `
            <td style="padding: 6px 8px; font-weight: bold; line-height: 1.2;">${displayName}</td>
            <td style="padding: 6px 8px; text-transform: uppercase; color: ${isShort ? 'var(--red)' : 'var(--green)'};">${direction}</td>
            <td style="padding: 6px 8px;">${qty.toFixed(4)} <span style="font-size: 9px; color: var(--muted);">(${fillsCount}/${limitCount} fills)</span></td>
            <td style="padding: 6px 8px;">$${entryPrice.toFixed(4)}</td>
            <td style="padding: 6px 8px;">$${currentPrice.toFixed(4)}</td>
            <td style="padding: 6px 8px; font-weight: bold; ${pnlStyle}">${pnlSign}$${unrealizedPnl.toFixed(2)}</td>
            <td style="padding: 6px 8px;">
              <button type="button" class="action-btn" style="background: var(--red); padding: 2px 6px; font-size: 9px; border-radius: 4px;" onclick="window.manualCloseAutoTradePosition('${pos.id}')">${currentLang === 'en' ? 'Close' : 'Закрыть'}</button>
            </td>
          `;
          positionsBody.appendChild(tr);
        });
      }
    }

    // 2. Render Trade Logs
    const logsContainer = document.getElementById('autoTradeLogsContainer');
    if (logsContainer) {
      if (data.logs && data.logs.length > 0) {
        logsContainer.textContent = data.logs.join('\n');
      } else {
        logsContainer.textContent = currentLang === 'en' ? 'No trade logs yet.' : 'Логов торговли нет.';
      }
    }

    // 3. Render Trade History
    const historyList = document.getElementById('autoTradeHistoryList');
    if (historyList) {
      historyList.innerHTML = '';

      if (!data.tradeHistory || data.tradeHistory.length === 0) {
        const p = document.createElement('p');
        p.className = 'placeholder-text';
        p.style.fontSize = '11px';
        p.style.color = 'var(--muted)';
        p.textContent = currentLang === 'en' ? 'No completed trades yet.' : 'Нет совершенных сделок.';
        historyList.appendChild(p);
      } else {
        data.tradeHistory.forEach(trade => {
          const item = document.createElement('div');
          item.style.background = 'rgba(15,19,23,0.3)';
          item.style.border = '1px solid var(--line)';
          item.style.borderRadius = '6px';
          item.style.padding = '8px';
          item.style.fontSize = '11px';
          item.style.display = 'flex';
          item.style.justifyContent = 'space-between';
          item.style.alignItems = 'center';

          const direction = trade.direction || 'long';
          const profit = trade.profit || 0;
          const pnlStyle = profit >= 0 ? 'color: var(--green);' : 'color: var(--red);';
          const pnlSign = profit >= 0 ? '+' : '';

          const timeStr = new Date(trade.exitTimestamp || trade.timestamp).toLocaleTimeString();
          const subaccountLabel = (trade.exchange === '01_exchange' || trade.exchange === 'hibachi') ? ` [Sub #${trade.subaccountIndex ?? 0}]` : '';
          const stratName = trade.strategyName ? ` | ${trade.strategyName}${subaccountLabel}` : '';

          item.innerHTML = `
            <div>
              <strong>HYPE</strong> <span style="text-transform: uppercase; color: ${direction === 'short' ? 'var(--red)' : 'var(--green)'};">${direction}</span>
              <span style="color: var(--muted); margin-left: 6px;">Qty: ${trade.qty?.toFixed(4)}</span>
              <span style="color: var(--muted); margin-left: 6px;">Entry: $${trade.avgPrice?.toFixed(4)}</span>
              <span style="color: var(--muted); margin-left: 6px;">Exit: $${trade.exitPrice?.toFixed(4)}</span>
              <div style="font-size: 9px; color: var(--muted); margin-top: 2px;">Reason: ${trade.exitReason || 'Closed'}${stratName} | Time: ${timeStr}</div>
            </div>
            <strong style="${pnlStyle}">${pnlSign}$${profit.toFixed(2)}</strong>
          `;
          historyList.appendChild(item);
        });
      }
    }
  } catch (err) {
    console.error('Error polling status:', err);
  }
}

async function manualClosePosition(id) {
  const currentLang = localStorage.getItem('hype_twap_lang') || 'en';
  try {
    const response = await fetch('/api/autotrade/close', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ id })
    });
    if (response.ok) {
      refreshAutoTradeStatus();
    } else {
      const err = await response.json();
      alert((currentLang === 'en' ? 'Close failed: ' : 'Закрытие не удалось: ') + (err.error || ''));
    }
  } catch (err) {
    console.error('Error closing position:', err);
  }
}

// Expose manual close to window context for table buttons onclick handler
window.manualCloseAutoTradePosition = manualClosePosition;

// Run startup
startup();

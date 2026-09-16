/* ============================================================
 * ECharts 图表：PCS运行情况 / 主要设备负载
 * ============================================================ */
window.Charts = (function () {
  'use strict';
  let pcs = null, load = null;
  const AX = '#6b9490', SPL = 'rgba(46,230,200,.08)';
  const TIP = {
    trigger: 'axis',
    backgroundColor: 'rgba(6,18,20,.92)',
    borderColor: 'rgba(46,230,200,.35)',
    textStyle: { color: '#cfeee8', fontSize: 11 },
    axisPointer: { lineStyle: { color: 'rgba(46,230,200,.4)' } }
  };
  const LEG = names => ({
    top: 0, right: 2, itemWidth: 10, itemHeight: 4, itemGap: 14,
    textStyle: { color: AX, fontSize: 10 }, data: names
  });
  const CAT_X = () => ({
    type: 'category', boundaryGap: false,
    axisLine: { lineStyle: { color: 'rgba(46,230,200,.25)' } },
    axisTick: { show: false },
    axisLabel: { color: AX, fontSize: 10 }
  });
  const VAL_Y = () => ({
    type: 'value',
    axisLabel: { color: AX, fontSize: 10 },
    splitLine: { lineStyle: { color: SPL, type: 'dashed' } }
  });
  function area(color) {
    return new echarts.graphic.LinearGradient(0, 0, 0, 1, [
      { offset: 0, color: color.replace('1)', '.35)') },
      { offset: 1, color: color.replace('1)', '0)') }
    ]);
  }

  function init() {
    pcs = echarts.init(document.getElementById('pcsChart'));
    pcs.setOption({
      grid: { left: 46, right: 14, top: 30, bottom: 22 },
      legend: LEG(['实际功率', '额定功率']),
      tooltip: Object.assign({ valueFormatter: v => v == null ? '-' : v + ' kW' }, TIP),
      xAxis: CAT_X(), yAxis: VAL_Y(),
      series: [
        {
          name: '实际功率', type: 'line', smooth: true, symbol: 'none',
          lineStyle: { width: 2, color: '#ffb020' },
          areaStyle: { color: area('rgba(255,176,32,1)') },
          data: []
        },
        {
          name: '额定功率', type: 'line', smooth: true, symbol: 'none',
          lineStyle: { width: 1.4, color: 'rgba(46,230,200,.85)', type: 'dashed' },
          data: []
        }
      ]
    });

    load = echarts.init(document.getElementById('loadChart'));
    load.setOption({
      grid: { left: 46, right: 14, top: 30, bottom: 22 },
      legend: LEG(['用户负载功率', '储能充放电功率']),
      tooltip: Object.assign({ valueFormatter: v => v == null ? '-' : v + ' kW' }, TIP),
      xAxis: CAT_X(), yAxis: VAL_Y(),
      series: [
        {
          name: '用户负载功率', type: 'line', smooth: true, symbol: 'none',
          lineStyle: { width: 2, color: '#35e0ff' },
          areaStyle: { color: area('rgba(53,224,255,1)') },
          data: []
        },
        {
          name: '储能充放电功率', type: 'line', smooth: true, symbol: 'none',
          lineStyle: { width: 2, color: '#3df0a0' },
          areaStyle: { color: area('rgba(61,240,160,1)') },
          data: []
        }
      ]
    });
  }

  function applyData(d) {
    if (pcs) pcs.setOption({ xAxis: { data: d.pcs.labels }, series: [{ data: d.pcs.actual }, { data: d.pcs.rated }] });
    if (load) load.setOption({ xAxis: { data: d.load.labels }, series: [{ data: d.load.user }, { data: d.load.storage }] });
  }

  function resize() { pcs && pcs.resize(); load && load.resize(); }

  return { init, applyData, resize };
})();

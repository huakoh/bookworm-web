'use strict';

// ─── #11 Prometheus 指标收集 ───
// 轻量实现，无外部依赖，输出 Prometheus text format

class Metrics {
  constructor() {
    this.counters = {};
    this.histograms = {};
    this.gauges = {};

    // 预定义指标
    this._defineCounter('http_requests_total', '请求总数', ['method', 'path', 'status']);
    this._defineHistogram('http_request_duration_ms', '请求延迟(ms)', ['method', 'path']);
    this._defineGauge('active_connections', '活跃连接数');
    this._defineGauge('uptime_seconds', '运行时间(秒)');
    this._defineCounter('route_queries_total', '路由查询总数', ['primary']);
    this._defineCounter('chat_requests_total', 'Chat 请求总数', ['model', 'stream']);
    this._defineCounter('auth_events_total', '认证事件总数', ['event']); // login_success, login_fail, register
  }

  _defineCounter(name, help, labelNames = []) {
    this.counters[name] = { help, labelNames, values: {} };
  }

  _defineHistogram(name, help, labelNames = []) {
    this.histograms[name] = {
      help, labelNames,
      buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 5000, 10000],
      values: {},
    };
  }

  _defineGauge(name, help) {
    this.gauges[name] = { help, value: 0 };
  }

  _labelKey(labels) {
    if (!labels || Object.keys(labels).length === 0) return '';
    return Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',');
  }

  incCounter(name, labels = {}, value = 1) {
    const counter = this.counters[name];
    if (!counter) return;
    const key = this._labelKey(labels);
    counter.values[key] = (counter.values[key] || 0) + value;
  }

  observeHistogram(name, labels = {}, value) {
    const hist = this.histograms[name];
    if (!hist) return;
    const key = this._labelKey(labels);
    if (!hist.values[key]) {
      hist.values[key] = { sum: 0, count: 0, buckets: {} };
      for (const b of hist.buckets) hist.values[key].buckets[b] = 0;
    }
    const entry = hist.values[key];
    entry.sum += value;
    entry.count++;
    for (const b of hist.buckets) {
      if (value <= b) entry.buckets[b]++;
    }
  }

  setGauge(name, value) {
    if (this.gauges[name]) this.gauges[name].value = value;
  }

  // 输出 Prometheus text format
  serialize() {
    const lines = [];

    // Counters
    for (const [name, counter] of Object.entries(this.counters)) {
      lines.push(`# HELP ${name} ${counter.help}`);
      lines.push(`# TYPE ${name} counter`);
      for (const [labelKey, value] of Object.entries(counter.values)) {
        const labels = labelKey ? `{${labelKey}}` : '';
        lines.push(`${name}${labels} ${value}`);
      }
    }

    // Histograms
    for (const [name, hist] of Object.entries(this.histograms)) {
      lines.push(`# HELP ${name} ${hist.help}`);
      lines.push(`# TYPE ${name} histogram`);
      for (const [labelKey, entry] of Object.entries(hist.values)) {
        const labelPrefix = labelKey ? `${labelKey},` : '';
        for (const [bucket, count] of Object.entries(entry.buckets)) {
          lines.push(`${name}_bucket{${labelPrefix}le="${bucket}"} ${count}`);
        }
        lines.push(`${name}_bucket{${labelPrefix}le="+Inf"} ${entry.count}`);
        lines.push(`${name}_sum{${labelKey ? labelKey : ''}} ${entry.sum}`);
        lines.push(`${name}_count{${labelKey ? labelKey : ''}} ${entry.count}`);
      }
    }

    // Gauges
    for (const [name, gauge] of Object.entries(this.gauges)) {
      lines.push(`# HELP ${name} ${gauge.help}`);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name} ${gauge.value}`);
    }

    return lines.join('\n') + '\n';
  }
}

module.exports = { Metrics };

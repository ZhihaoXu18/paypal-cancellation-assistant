async function checkHealth() {
  const indicator = document.getElementById('health');
  try {
    const response = await fetch('/api/health');
    if (!response.ok) throw new Error('健康检查失败');
    const health = await response.json();
    indicator.textContent = health.status === 'ok' ? '应用状态：正常' : '应用状态：异常';
  } catch {
    indicator.textContent = '应用状态：连接失败，请检查本地服务';
  }
}

checkHealth();

// 后端地址解析：PC 用 localhost 打开、平板用局域网 IP 打开，都指向同一台机器的后端。
// 优先 VITE_API_BASE（后端部署到其他主机时覆盖），否则按当前页面 host 推导。
function resolveApiBase(): string {
  const envBase = (import.meta.env.VITE_API_BASE as string | undefined)?.trim()
  if (envBase) return envBase.replace(/\/$/, "")
  const { protocol, hostname } = window.location
  return `${protocol === "https:" ? "https:" : "http:"}//${hostname || "127.0.0.1"}:8000/api`
}

export const API_BASE = resolveApiBase()

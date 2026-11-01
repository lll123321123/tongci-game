/*
 * ============================================================
 *  同词相遇 · 腾讯云 CloudBase 配置
 * ============================================================
 *
 *  只需要填这三项（前两项必填）：
 *
 *  1. CLOUDBASE_ENV_ID
 *     CloudBase 控制台 → 环境概览 / 环境设置
 *     复制「环境 ID（EnvId）」，形如：
 *     my-game-1a2b3c
 *
 *  2. CLOUDBASE_PUBLISHABLE_KEY
 *     CloudBase 控制台 → 环境配置 → API Key
 *     生成/复制「Publishable Key」。
 *     它是公开密钥，可以放在静态前端中；
 *     不要在这里放服务端 API Key、SecretId 或 SecretKey。
 *
 *  3. CLOUDBASE_REGION（可选）
 *     默认 ap-shanghai。环境实际地域必须与此一致：
 *     ap-shanghai / ap-guangzhou / ap-singapore
 *
 *  本游戏只使用 CloudBase Realtime Broadcast：
 *  - 不建数据库表
 *  - 不配置 RLS
 *  - 不需要云函数或自建 WebSocket 服务
 *
 *  重要：部署到 EdgeOne Pages 后，请把 EdgeOne 生成的域名
 *  （预览域名和生产/自定义域名）加入 CloudBase：
 *  环境配置 → 安全来源 → 安全域名。
 */
window.TONGCI_CONFIG = {
  CLOUDBASE_ENV_ID: "nuclear-starfish-d2efoifb67d2351",
  CLOUDBASE_PUBLISHABLE_KEY:
    "eyJhbGciOiJSUzI1NiIsImtpZCI6Ijg3ZTgwMDg2LWVjZmItNGY0OS05N2QyLTcwZWM3OTdlYzcxOCJ9.eyJpc3MiOiJodHRwczovL251Y2xlYXItc3RhcmZpc2gtZDJlZm9pZmI2N2QyMzUxLmFwLXNoYW5naGFpLnRjYi1hcGkudGVuY2VudGNsb3VkYXBpLmNvbSIsInN1YiI6ImFub24iLCJhdWQiOiJudWNsZWFyLXN0YXJmaXNoLWQyZWZvaWZiNjdkMjM1MSIsImV4cCI6NDA5NzIxMTg4MywiaWF0IjoxNzkzNTI4NjgzLCJub25jZSI6Im1DWkpHZU1iU3JPTHhEYmpGaTFSWFEiLCJhdF9oYXNoIjoibUNaSkdlTWJTck9MeERiakZpMVJYUSIsIm5hbWUiOiJBbm9ueW1vdXMiLCJzY29wZSI6ImFub255bW91cyIsInByb2plY3RfaWQiOiJudWNsZWFyLXN0YXJmaXNoLWQyZWZvaWZiNjdkMjM1MSIsIm1ldGEiOnsicGxhdGZvcm0iOiJQdWJsaXNoYWJsZUtleSJ9LCJyb2xlIjoiYW5vbiIsImlzX2Fub255bW91cyI6dHJ1ZSwiYXBwX21ldGFkYXRhIjp7InByb3ZpZGVyIjoiYW5vbnltb3VzIiwicHJvdmlkZXJzIjpbImFub255bW91cyJdfSwidXNlcl9tZXRhZGF0YSI6eyJuYW1lIjoiQW5vbnltb3VzIn0sInVzZXJfdHlwZSI6IiIsImNsaWVudF90eXBlIjoiY2xpZW50X3VzZXIiLCJpc19zeXN0ZW1fYWRtaW4iOmZhbHNlfQ.jYKgURoNlBgcyYkki2UyWNBxKPNZrQc1Nl8go_XLuKGL1ylXSGS6J2gWkSt5XhNQuZuct2q_0dJOJmWhoUvb9BL7D7_q2Uf-ndIDT5zUoW5kYkEtpdxdw03cf0wBcu_Lzbz1T-zSdxLluo7StGqh93uwL20eTUUmvHPnjiOWxsda54EAWSZohAH-DBHi1He9oaCDiO8YXVBvMNU8lmunEAy1J52lLBRbyMvzuVu4xcti16bShef_21x5CWRyRmRJiY-8vSPkqcMy8clqh37JeqlDM1V5fhp8OSCeXxgsANPN8lUV-uiwc8sS5VCBO-9CKB-1Oy0o6skbKlqxtDgNcw",
  CLOUDBASE_REGION: "ap-shanghai",
};

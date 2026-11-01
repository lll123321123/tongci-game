/*
 * ============================================================
 *  同词相遇 · Supabase 配置
 * ============================================================
 *
 *  只需要填这两个值：
 *
 *  1. SUPABASE_URL
 *     Supabase 控制台 → 你的项目 → Project Settings → API
 *     复制 "Project URL"，形如：
 *     https://abcdefghijklmnop.supabase.co
 *
 *  2. SUPABASE_ANON_KEY
 *     推荐复制新版 "publishable" key（sb_publishable_...）。
 *     旧版 "anon public" key 仍然兼容。
 *     它是公开密钥，可以放在静态前端中；
 *     不要在这里放 service_role / secret key。
 *
 *  本游戏只使用 Supabase Realtime Broadcast，不需要创建任何数据表，
 *  也不需要配置 RLS。频道名为 room:<房间号>，公开频道即可。
 */
window.TONGCI_CONFIG = {
  SUPABASE_URL: "https://ypocfjqztgdntivaahvo.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_ALMxnfUP_tlpcoobKh9ZBw_9aIv9c1o",
};

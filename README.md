# CABO 四人線上遊戲

這是一個以 Node.js、Express、Socket.IO 製作的即時多人 CABO 網頁遊戲原型，適合部署到 Render，並透過 GitHub 管理程式碼。玩家可用手機、平板或電腦開啟同一個網址，使用房間代碼加入。

## 本機執行

需要 Node.js 20 或更新版本。

```bash
npm install
npm start
```

瀏覽器開啟 `http://localhost:3000`。

## 部署到 GitHub + Render

1. 在 GitHub 建立新的 repository，例如 `cabo-online`。
2. 將此資料夾中的所有檔案上傳到 repository 根目錄。
3. 登入 Render，選擇 **New + → Web Service**，連接這個 GitHub repository。
4. Render 設定：
   - Runtime：Node
   - Build Command：`npm install`
   - Start Command：`npm start`
   - Health Check Path：`/health`
5. 選擇可用方案並部署。部署完成後，Render 會提供 `https://...onrender.com` 網址。
6. 將網址傳給朋友；一人建立房間，另外三人輸入房間代碼加入。

`render.yaml` 也包含基本服務設定，可用 Render Blueprint 匯入。

## 已實作的主要功能

- 四人房間與房間代碼
- 房主開始遊戲
- 起始手牌與近身兩張的查看流程
- 抽牌、交換、直接棄牌
- 7/8、9/10、J/Q、K/A 特殊能力的互動流程
- 配對自己或其他玩家手牌
- 配對失敗時收回棄牌堆頂牌、保持錯誤手牌原位，不額外抽懲罰牌
- CABO 宣告、宣告者手牌保護、最後回合結算
- 52 張抽牌堆耗盡時立即結束
- 分數結算、已知牌的玩家別權限管理
- 手機優先的響應式介面

## 重要注意事項

這是可供試玩和繼續開發的第一版，不是經完整遊戲測試的正式競技版本。請先用四個瀏覽器/裝置測試完整流程，尤其是：

- 特殊能力的「不交換」操作與目標選擇。
- 同時發出配對請求時的競態條件。
- CABO 宣告後的最後回合順序。
- 手牌達 4 張以上時，遠右側新增牌位的視覺呈現。
- 抽牌堆最後一張牌抽出後立即結束的規則。

目前房間狀態存在 Node 伺服器記憶體中。若 Render 重新啟動服務，遊戲中的房間會消失；免費服務也可能休眠。此版本不含帳號系統、資料庫、跨伺服器持久化或斷線重新加入。

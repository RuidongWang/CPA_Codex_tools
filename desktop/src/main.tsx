import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// 入口只保留渲染职责，避免把状态逻辑堆进根文件。
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

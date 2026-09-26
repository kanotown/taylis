import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./ui/App";
import { AppController } from "./state/app";
import "./styles.css";

const controller = new AppController();
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App controller={controller} />
  </React.StrictMode>,
);
void controller.boot();

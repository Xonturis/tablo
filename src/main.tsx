import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./ui/App";
import "./ui/app.css";

registerSW({ immediate: true });

// No StrictMode: its double-mounting in development would join/leave the P2P room twice.
createRoot(document.getElementById("root")!).render(<App />);

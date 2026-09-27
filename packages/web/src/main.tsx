import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "./styles.css";
import { App } from "./App.js";
import { AuthProvider } from "./auth/context.js";

// pdf.js worker bundled by Vite from the installed pdfjs-dist.
pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>,
);

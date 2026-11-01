import { render } from "preact";
import { loadInitialWorkspace } from "./session";
import { App } from "./ui/App";
import "./ui/styles.css";

declare global {
  interface Window {
    coiReady: Promise<void>;
    coiStatus: string;
  }
}

window.coiReady.then(async () => {
  const initialCode = await loadInitialWorkspace();
  render(<App initialCode={initialCode} />, document.getElementById("app")!);
});

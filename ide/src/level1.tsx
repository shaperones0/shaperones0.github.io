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
  const initial = await loadInitialWorkspace();
  render(<App initial={initial} />, document.getElementById("app")!);
});

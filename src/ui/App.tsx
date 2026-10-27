import { useEffect, useState } from "react";
import { getProject, libraryReady, parseShareLink, updateProject, upsertProject } from "../store/library";
import { navigate, replaceRoute, useHashRoute } from "./hooks";
import { Home } from "./Home";
import { ProjectView } from "./ProjectView";

export function App() {
  const [ready, setReady] = useState(false);
  const route = useHashRoute();

  useEffect(() => {
    libraryReady.then(() => setReady(true));
  }, []);

  // #/join/<id>/<secret>/<name>: add the shared project to this device, then open it
  useEffect(() => {
    if (!ready || route[0] !== "join") return;
    const link = parseShareLink(location.hash);
    if (!link) return navigate("/");
    const existing = getProject(link.id);
    if (existing) {
      updateProject(link.id, { sharing: true, secret: link.secret });
    } else {
      const now = Date.now();
      upsertProject({
        id: link.id,
        name: link.name,
        secret: link.secret,
        createdAt: now,
        openedAt: now,
        sharing: true,
        joined: true,
      });
    }
    replaceRoute(`/p/${link.id}`);
  }, [ready, route]);

  if (!ready || route[0] === "join") return <div className="splash">Loading…</div>;
  if (route[0] === "p" && route[1]) {
    if (!getProject(route[1])) return <Home notice="That project isn't on this device." />;
    return <ProjectView key={route[1]} projectId={route[1]} boardId={route[2] ?? null} />;
  }
  return <Home />;
}

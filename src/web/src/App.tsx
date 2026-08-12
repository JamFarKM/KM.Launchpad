import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./api/client";
import { ConnectPage } from "./pages/ConnectPage";
import { Dashboard } from "./pages/Dashboard";
import { SequencesPage } from "./pages/Sequences";
import { ConfigurationsPage } from "./pages/Configurations";
import { KeyVaultPage } from "./pages/KeyVault";
import { ReviewPage } from "./pages/Review";
import { TopBar, type Page } from "./components/TopBar";
import type { User } from "./types";

export function App() {
  const qc = useQueryClient();
  const me = useQuery<User>({
    queryKey: ["me"],
    queryFn: api.me,
    retry: false,
  });

  // If any request 401s (session lapsed), drop back to the connect screen.
  useEffect(() => {
    const onUnauthorized = () => {
      qc.setQueryData(["me"], null);
      qc.removeQueries({ queryKey: ["me"] });
    };
    window.addEventListener("pl-unauthorized", onUnauthorized);
    return () => window.removeEventListener("pl-unauthorized", onUnauthorized);
  }, [qc]);

  if (me.isLoading) {
    return <div className="center-note"><span className="spin" /> Loading…</div>;
  }

  const unauthorized = me.error instanceof ApiError && me.error.status === 401;
  if (!me.data || unauthorized) {
    return (
      <ConnectPage
        onConnected={(user) => {
          qc.setQueryData(["me"], user);
        }}
      />
    );
  }

  return (
    <AppShell
      user={me.data}
      onDisconnect={async () => {
        await api.disconnect();
        qc.setQueryData(["me"], null);
        qc.clear();
      }}
    />
  );
}

function AppShell({ user, onDisconnect }: { user: User; onDisconnect: () => void }) {
  const qc = useQueryClient();
  const [page, setPage] = useState<Page>("views");
  return (
    <div className="app">
      <TopBar
        user={user}
        page={page}
        onNav={setPage}
        onDisconnect={onDisconnect}
        onImported={() => {
          qc.invalidateQueries({ queryKey: ["views"] });
          qc.invalidateQueries({ queryKey: ["sequences"] });
          setPage("views");
        }}
      />
      {page === "views" && <Dashboard />}
      {page === "sequences" && <SequencesPage />}
      {page === "configurations" && <ConfigurationsPage />}
      {page === "review" && <ReviewPage />}
      {page === "keyvault" && <KeyVaultPage />}
      <footer className="app-footer">
        Launchpad · by James Farrugia
      </footer>
    </div>
  );
}

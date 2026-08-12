import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./api/client";
import { ConnectPage } from "./pages/ConnectPage";
import { Dashboard } from "./pages/Dashboard";
import { SequencesPage, type SequenceIntent } from "./pages/Sequences";
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
  /** What the Sequences page should open with, when we arrive there from the library drawer. */
  const [seqIntent, setSeqIntent] = useState<SequenceIntent>(null);

  /* Configurations and Key Vault are only useful once a store is registered, and an empty page
     behind a nav tab reads as a broken feature rather than an unconfigured one. Both queries are
     cheap and cached, so the tabs appear the moment the first registry is added. Nothing is
     hidden while the queries are still in flight — a tab that flickers away is worse. */
  const configsQ = useQuery({ queryKey: ["config-registries"], queryFn: api.configRegistries, retry: false });
  const vaultsQ = useQuery({ queryKey: ["vault-registries"], queryFn: api.vaultRegistries, retry: false });
  const hidden = new Set<Page>();
  if (configsQ.isSuccess && configsQ.data.length === 0) hidden.add("configurations");
  if (vaultsQ.isSuccess && vaultsQ.data.length === 0) hidden.add("keyvault");

  // Never strand the user on a tab that just disappeared (deleting your last registry).
  useEffect(() => { if (hidden.has(page)) setPage("views"); }, [hidden, page]);

  const openSequence = (intent: SequenceIntent) => { setSeqIntent(intent); setPage("sequences"); };

  return (
    <div className="app">
      <TopBar
        user={user}
        page={page}
        hidden={hidden}
        onNav={setPage}
        onDisconnect={onDisconnect}
        onImported={() => {
          qc.invalidateQueries({ queryKey: ["views"] });
          qc.invalidateQueries({ queryKey: ["sequences"] });
          setPage("views");
        }}
      />
      {page === "views" && (
        <Dashboard
          onEditSequence={(id) => openSequence({ kind: "edit", id })}
          onNewSequence={() => openSequence({ kind: "new" })}
        />
      )}
      {page === "sequences" && <SequencesPage intent={seqIntent} onIntentUsed={() => setSeqIntent(null)} />}
      {page === "configurations" && <ConfigurationsPage />}
      {page === "review" && <ReviewPage />}
      {page === "keyvault" && <KeyVaultPage />}
      <footer className="app-footer">
        Launchpad · by James Farrugia
      </footer>
    </div>
  );
}

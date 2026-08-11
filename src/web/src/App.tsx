import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./api/client";
import { ConnectPage } from "./pages/ConnectPage";
import { Dashboard } from "./pages/Dashboard";
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
    <Dashboard
      user={me.data}
      onDisconnect={async () => {
        await api.disconnect();
        qc.setQueryData(["me"], null);
        qc.clear();
      }}
    />
  );
}

import DashboardShell from "@/components/DashboardShell";
import TransactionsView from "@/components/TransactionsView";

export default function Home() {
  return (
    <DashboardShell>
      <TransactionsView />
    </DashboardShell>
  );
}

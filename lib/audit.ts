import { createAdminClient } from "@/lib/supabase/server";

interface AuditEntry {
  user_email: string;
  action: string;
  filters?: Record<string, unknown>;
  result_count?: number;
}

export async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    const supabase = createAdminClient();
    await supabase.from("audit_logs").insert(entry);
  } catch {
    // No interrumpir el flujo si falla el log
  }
}

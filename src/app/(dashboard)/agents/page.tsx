/**
 * Canonical Agent OS home. The shared server-rendered implementation remains in
 * the receptionist route during this small IA reconciliation so existing links
 * keep working without duplicating data access or client state.
 */
import AgentHome from "../receptionist/page"

export const dynamic = "force-dynamic"

export default AgentHome

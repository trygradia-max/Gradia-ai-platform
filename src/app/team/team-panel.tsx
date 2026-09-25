"use client"

import { useActionState, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { runTeamCommand, type TeamResult } from "@/app/actions/team"
import {
  CAPABILITY_LABELS,
  TEAM_CAPABILITIES,
  nextJobStatuses,
  type TeamMember,
  type TeamWorkspace,
} from "@/lib/team-permissions"

export type TeamData = {
  members: TeamMember[]
  customers: { id: string; name: string | null }[]
  jobs: {
    id: string
    customer_id: string | null
    service_name: string | null
    scheduled_at: string
    status: string
  }[]
  assignments: {
    id: string
    member_id: string
    customer_id: string | null
    appointment_id: string | null
  }[]
  invitations: {
    id: string
    email: string
    role: string
    status: string
    expires_at: string
  }[]
  audit: { id: string; actor_id: string; event: string; created_at: string }[]
  notes: {
    id: string
    customer_id: string
    content: string
    created_at: string
  }[]
}
const field = "block w-full rounded-md border bg-background px-3 py-2 text-sm"
const box = "space-y-4 rounded-xl border bg-card p-5"
const value = (data: FormData, name: string) => String(data.get(name) ?? "")

function ActionForm({
  build,
  children,
  label,
}: {
  build: (data: FormData) => unknown
  children?: React.ReactNode
  label: string
}) {
  const router = useRouter()
  const [state, action, pending] = useActionState(
    async (_previous: TeamResult, data: FormData): Promise<TeamResult> => {
      try {
        const result = await runTeamCommand(build(data))
        if (result.ok) router.refresh()
        return result
      } catch {
        return {
          ok: false,
          message: "Could not confirm the result. Refresh before retrying.",
        }
      }
    },
    { ok: true, message: "" }
  )
  return (
    <form action={action} className="space-y-3">
      <fieldset disabled={pending} className="space-y-3">
        {children}
        <button
          className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
          type="submit"
        >
          {pending ? "Saving…" : label}
        </button>
      </fieldset>
      {state.message && (
        <p
          role={state.ok ? "status" : "alert"}
          className={state.ok ? "text-sm" : "text-sm text-destructive"}
        >
          {state.message}
        </p>
      )}
      {state.token && (
        <label className="block text-sm">
          Invitation code (shown once; keep private)
          <input
            readOnly
            aria-label="Invitation code"
            className={field}
            value={state.token}
            onFocus={(e) => e.currentTarget.select()}
            autoComplete="off"
          />
        </label>
      )}
    </form>
  )
}
function RoleFields({ member }: { member?: TeamMember }) {
  const [role, setRole] = useState(
    member?.role === "manager" ? "manager" : "staff"
  )
  return (
    <>
      <label className="block text-sm">
        Role
        <select
          className={field}
          name="role"
          value={role}
          onChange={(e) => setRole(e.target.value)}
        >
          <option value="staff">Staff — assigned work only</option>
          <option value="manager">Manager — explicit grants</option>
        </select>
      </label>
      {role === "manager" && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Delegate operations</legend>
          {TEAM_CAPABILITIES.map((cap) => (
            <label key={cap} className="flex gap-2 text-sm">
              <input
                type="checkbox"
                name="capabilities"
                value={cap}
                defaultChecked={member?.capabilities.includes(cap)}
              />
              {CAPABILITY_LABELS[cap]}
            </label>
          ))}
          <p className="text-xs text-muted-foreground">
            No grants are enabled by default. These never allow membership,
            connectors, autonomy changes, exports, merging or message delivery.
          </p>
        </fieldset>
      )}
    </>
  )
}
export function TeamPanel({
  workspace,
  data,
}: {
  workspace: TeamWorkspace
  data: TeamData
}) {
  const owner = workspace.role === "owner"
  const can = (cap: (typeof TEAM_CAPABILITIES)[number]) =>
    owner || workspace.capabilities.includes(cap)
  const memberName = (id: string) =>
    data.members.find((m) => m.id === id)?.display_name ?? "Member"
  const customerName = (id: string | null) =>
    data.customers.find((c) => c.id === id)?.name ?? "Customer"
  const recordName = (a: TeamData["assignments"][number]) =>
    a.customer_id
      ? customerName(a.customer_id)
      : (data.jobs.find((j) => j.id === a.appointment_id)?.service_name ??
        "Assigned job")
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">{workspace.name}</h1>
        <p className="text-muted-foreground">
          {owner
            ? "Your team and assigned work"
            : `${workspace.role === "manager" ? "Manager" : "Staff"} workspace`}{" "}
          · One shop location
        </p>
        {owner && (
          <Link className="text-sm underline" href="/dashboard">
            Back to dashboard
          </Link>
        )}
      </header>
      {owner && (
        <section className={box} aria-labelledby="team-members">
          <h2 id="team-members" className="text-lg font-medium">
            Shop members
          </h2>
          <p className="text-sm text-muted-foreground">
            Working solo? Your owner membership already gives you access. Add
            people only when needed.
          </p>
          {data.members.map((m) => (
            <article className="space-y-3 border-t pt-4" key={m.id}>
              <h3 className="font-medium">
                {m.display_name} · {m.role}
                {!m.active ? " · Disabled" : ""}
              </h3>
              {m.role === "owner" ? (
                <p className="text-sm">
                  Owner authority is preserved. Ownership transfer is not
                  available here.
                </p>
              ) : (
                <ActionForm
                  label="Save membership"
                  build={(f) => ({
                    operation: "member",
                    shopId: workspace.id,
                    memberId: m.id,
                    role: value(f, "role"),
                    capabilities: f.getAll("capabilities"),
                    active: f.get("active") === "on",
                  })}
                >
                  <RoleFields member={m} />
                  <label className="flex gap-2 text-sm">
                    <input
                      name="active"
                      type="checkbox"
                      defaultChecked={m.active}
                    />
                    Active membership
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Disabling removes access and assignments. Re-enabling
                    requires new assignments.
                  </p>
                </ActionForm>
              )}
            </article>
          ))}
          <details>
            <summary className="cursor-pointer font-medium">
              Invite a teammate
            </summary>
            <div className="pt-4">
              <ActionForm
                label="Create invitation"
                build={(f) => ({
                  operation: "invite",
                  shopId: workspace.id,
                  name: value(f, "name"),
                  email: value(f, "email"),
                  role: value(f, "role"),
                  capabilities: f.getAll("capabilities"),
                })}
              >
                <label className="block text-sm">
                  Name
                  <input
                    name="name"
                    required
                    maxLength={100}
                    className={field}
                  />
                </label>
                <label className="block text-sm">
                  Email
                  <input
                    name="email"
                    type="email"
                    required
                    maxLength={254}
                    className={field}
                  />
                </label>
                <RoleFields />
                <p className="text-sm">
                  Email delivery is disabled. Give the code securely to your
                  teammate, who must sign in with this verified email and accept
                  it at /team. Reissuing cancels the previous code.
                </p>
              </ActionForm>
            </div>
          </details>
          <h3 className="font-medium">Invitations</h3>
          {data.invitations.length === 0 && (
            <p className="text-sm">No invitations yet.</p>
          )}
          {data.invitations.map((i) => (
            <div key={i.id} className="space-y-2 border-t pt-3">
              <p className="text-sm">
                {i.email} · {i.role} · {i.status}
                {i.status === "pending" ? ` · expires ${i.expires_at}` : ""}
              </p>
              {i.status === "pending" && (
                <ActionForm
                  label="Cancel invitation"
                  build={() => ({
                    operation: "cancel",
                    shopId: workspace.id,
                    invitationId: i.id,
                  })}
                />
              )}
            </div>
          ))}
        </section>
      )}
      {can("assignments.manage") && (
        <section className={box}>
          <h2 className="text-lg font-medium">Assignments</h2>
          <ActionForm
            label="Assign work"
            build={(f) => {
              const [kind, id] = value(f, "record").split(":")
              return {
                operation: "assign",
                shopId: workspace.id,
                memberId: value(f, "member"),
                customerId: kind === "customer" ? id : null,
                appointmentId: kind === "job" ? id : null,
                remove: false,
              }
            }}
          >
            <label className="block text-sm">
              Teammate
              <select required name="member" className={field} defaultValue="">
                <option value="" disabled>
                  Select a teammate
                </option>
                {data.members
                  .filter((m) => m.active && (owner || m.role === "staff"))
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.display_name} ({m.role})
                    </option>
                  ))}
              </select>
            </label>
            <label className="block text-sm">
              Customer or job
              <select required name="record" className={field} defaultValue="">
                <option value="" disabled>
                  Select work
                </option>
                <optgroup label="Customers">
                  {data.customers.map((c) => (
                    <option key={c.id} value={`customer:${c.id}`}>
                      {c.name ?? "Unnamed customer"}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Jobs">
                  {data.jobs.map((j) => (
                    <option key={j.id} value={`job:${j.id}`}>
                      {j.service_name ?? "Job"} · {customerName(j.customer_id)}{" "}
                      · {j.scheduled_at.slice(0, 10)}
                    </option>
                  ))}
                </optgroup>
              </select>
            </label>
          </ActionForm>
          {data.assignments.length === 0 && (
            <p className="text-sm">No assignments yet.</p>
          )}
          {data.assignments.map((a) => (
            <div className="space-y-2 border-t pt-3" key={a.id}>
              <p className="text-sm">
                {memberName(a.member_id)} · {recordName(a)}
              </p>
              {(owner ||
                data.members.find((m) => m.id === a.member_id)?.role ===
                  "staff") && (
                <ActionForm
                  label="Remove assignment"
                  build={() => ({
                    operation: "assign",
                    shopId: workspace.id,
                    memberId: a.member_id,
                    customerId: a.customer_id,
                    appointmentId: a.appointment_id,
                    remove: true,
                  })}
                />
              )}
            </div>
          ))}
        </section>
      )}
      <section className={box}>
        <h2 className="text-lg font-medium">Permitted customers</h2>
        <p className="text-xs text-muted-foreground">
          Up to 50 customers. Staff see assigned customers and the customers of
          assigned jobs.
        </p>
        {data.customers.length === 0 && (
          <p>No customers available. Ask the owner for an assignment.</p>
        )}
        {data.customers.map((c) => (
          <details className="border-t pt-3" key={c.id}>
            <summary className="cursor-pointer">
              {c.name ?? "Unnamed customer"}
            </summary>
            <div className="space-y-3 pt-3">
              {data.notes
                .filter((n) => n.customer_id === c.id)
                .map((n) => (
                  <p key={n.id} className="whitespace-pre-wrap text-sm">
                    {n.content}
                  </p>
                ))}
              {(workspace.role === "staff" || can("notes.write")) && (
                <ActionForm
                  label="Add internal note"
                  build={(f) => ({
                    operation: "note",
                    shopId: workspace.id,
                    customerId: c.id,
                    content: value(f, "content"),
                  })}
                >
                  <label className="block text-sm">
                    Note
                    <textarea
                      name="content"
                      required
                      maxLength={4000}
                      className={field}
                    />
                  </label>
                </ActionForm>
              )}
            </div>
          </details>
        ))}
      </section>
      <section className={box}>
        <h2 className="text-lg font-medium">Permitted jobs</h2>
        <p className="text-xs text-muted-foreground">
          Up to 50 jobs. Progress updates do not reschedule work, change prices
          or send notifications.
        </p>
        {data.jobs.length === 0 && <p>No jobs available.</p>}
        {data.jobs.map((j) => (
          <article key={j.id} className="space-y-3 border-t pt-3">
            <h3>
              {j.service_name ?? "Job"} · {customerName(j.customer_id)}
            </h3>
            <p className="text-sm">
              {j.scheduled_at} · {j.status}
            </p>
            {(workspace.role === "staff" || can("jobs.progress")) &&
              nextJobStatuses[j.status]?.length > 0 && (
                <ActionForm
                  label="Update progress"
                  build={(f) => ({
                    operation: "progress",
                    shopId: workspace.id,
                    appointmentId: j.id,
                    expected: j.status,
                    status: value(f, "status"),
                  })}
                >
                  <label className="block text-sm">
                    Next status
                    <select name="status" className={field}>
                      {nextJobStatuses[j.status].map((s) => (
                        <option key={s} value={s}>
                          {s.replaceAll("_", " ")}
                        </option>
                      ))}
                    </select>
                  </label>
                </ActionForm>
              )}
          </article>
        ))}
      </section>
      {owner && (
        <section className={box}>
          <h2 className="text-lg font-medium">Team activity</h2>
          <p className="text-xs text-muted-foreground">
            Latest 50 authority and operational changes.
          </p>
          {data.audit.length === 0 && <p>No team changes recorded yet.</p>}
          {data.audit.map((a) => (
            <p key={a.id} className="text-sm">
              {data.members.find((m) => m.user_id === a.actor_id)
                ?.display_name ?? "Former member"}{" "}
              · {a.event.replaceAll("_", " ")} · {a.created_at}
            </p>
          ))}
        </section>
      )}
    </div>
  )
}
export function AcceptInvitation() {
  return (
    <section className={box}>
      <h2 className="text-lg font-medium">Accept an invitation</h2>
      <p className="text-sm">
        Sign in with the verified email your owner invited. Paste the private
        invitation code here; do not put it in a URL.
      </p>
      <ActionForm
        label="Accept invitation"
        build={(f) => ({
          operation: "accept",
          token: value(f, "token").trim(),
        })}
      >
        <label className="block text-sm">
          Invitation code
          <input
            name="token"
            required
            pattern="[a-f0-9]{64}"
            autoComplete="off"
            className={field}
          />
        </label>
      </ActionForm>
    </section>
  )
}

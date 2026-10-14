import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { KeyRound, LogOut, Trash2, UserPlus, Users } from "lucide-react";
import { api } from "./api";
import { useAction, useWorkspace } from "./ui";

// Sign-in shown when the installation runs with REQUIRE_LOGIN. bootstrap mode
// (no password user yet) asks for a name and creates the first account. This
// renders outside the workspace context, so errors are shown inline.
export function LoginScreen({ bootstrap }: { bootstrap: boolean }) {
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="hf-app hf-center">
      <form
        className="panel settings-panel form-grid"
        style={{ width: 400 }}
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          setPending(true);
          setError("");
          api(bootstrap ? "/auth/bootstrap" : "/auth/login", {
            name: f.get("name") || undefined,
            email: f.get("email"),
            password: f.get("password"),
          })
            .then(() => location.reload())
            .catch((e: Error) => {
              setError(e.message);
              setPending(false);
            });
        }}
      >
        <h2>{bootstrap ? "Create the first account" : "Sign in"}</h2>
        <p className="muted">
          {bootstrap
            ? "This becomes the first owner. Add teammates later under Settings → People."
            : "Sign in to Helix Foundry."}
        </p>
        {bootstrap && (
          <label className="span2">
            Your name
            <input name="name" required autoFocus />
          </label>
        )}
        <label className="span2">
          Email
          <input name="email" type="email" required autoFocus={!bootstrap} />
        </label>
        <label className="span2">
          Password
          <input
            name="password"
            type="password"
            required
            minLength={bootstrap ? 8 : 1}
          />
        </label>
        {error && <p className="error span2">{error}</p>}
        <button className="button primary span2" disabled={pending}>
          {bootstrap ? "Create account" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

// Workspace members: everyone can read the list; owners add people, change
// roles and remove members.
export function MembersPanel() {
  const { id, role, user, notify } = useWorkspace(),
    owner = role === "owner",
    action = useAction(),
    members = useQuery({
      queryKey: ["members", id],
      queryFn: () => api(`/workspaces/${id}/members`),
    });
  return (
    <section className="panel settings-panel">
      <div className="panel-title">
        <h3>
          <Users size={18} /> Workspace members
        </h3>
      </div>
      <div className="pad">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              {owner && <th></th>}
            </tr>
          </thead>
          <tbody>
            {(members.data?.members || []).map((m: any) => (
              <tr key={m.userId}>
                <td>{m.name}</td>
                <td>{m.email || "—"}</td>
                <td>
                  {owner ? (
                    <select
                      value={m.role}
                      onChange={(e) =>
                        action
                          .run(() =>
                            api(
                              `/workspaces/${id}/members/${m.userId}`,
                              { role: e.target.value },
                              "PATCH",
                            ),
                          )
                          .then((r) => r === undefined || notify("Role updated"))
                      }
                    >
                      <option value="viewer">Viewer</option>
                      <option value="editor">Editor</option>
                      <option value="owner">Owner</option>
                    </select>
                  ) : (
                    m.role
                  )}
                </td>
                {owner && (
                  <td>
                    <button
                      className="button small"
                      title="Remove member"
                      onClick={() =>
                        action
                          .run(() =>
                            api(
                              `/workspaces/${id}/members/${m.userId}`,
                              undefined,
                              "DELETE",
                            ),
                          )
                          .then((r) => r === undefined || notify("Member removed"))
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {owner && (
          <form
            className="form-grid"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              action
                .run(() =>
                  api(`/workspaces/${id}/members`, {
                    email: f.get("email"),
                    name: f.get("name") || undefined,
                    role: f.get("role"),
                    password: f.get("password") || undefined,
                  }),
                  "Member added",
                )
                .then((r) => r && e.currentTarget.reset());
            }}
          >
            <h4 className="span2">
              <UserPlus size={15} /> Add a teammate
            </h4>
            <label>
              Email
              <input name="email" type="email" required />
            </label>
            <label>
              Name
              <input name="name" placeholder="Uses email if blank" />
            </label>
            <label>
              Role
              <select name="role" defaultValue="editor">
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
                <option value="owner">Owner</option>
              </select>
            </label>
            <label>
              First password
              <input
                name="password"
                type="password"
                minLength={8}
                placeholder="Only for a new user"
              />
            </label>
            <p className="muted span2">
              An email that is new here creates an account; share its first
              password with them directly.
            </p>
            <button className="button" disabled={action.pending}>
              Add member
            </button>
          </form>
        )}
      </div>
    </section>
  );
}

// The signed-in person's own account: password change and sign-out. Password
// is only offered to password users (local single-computer mode has none).
export function AccountPanel() {
  const { user, notify } = useWorkspace(),
    action = useAction();
  return (
    <section className="panel settings-panel">
      <div className="panel-title">
        <h3>
          <KeyRound size={18} /> Your account
        </h3>
      </div>
      <div className="pad">
        <p className="muted">
          Signed in as <strong>{user?.name}</strong>
          {user?.email ? ` (${user.email})` : ""}
        </p>
        {user?.email && (
          <form
            className="form-grid"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              action
                .run(
                  () =>
                    api("/auth/password", {
                      current: f.get("current"),
                      next: f.get("next"),
                    }),
                  "Password updated",
                )
                .then((r) => r && e.currentTarget.reset());
            }}
          >
            <label>
              Current password
              <input name="current" type="password" required />
            </label>
            <label>
              New password
              <input name="next" type="password" required minLength={8} />
            </label>
            <button className="button" disabled={action.pending}>
              Change password
            </button>
          </form>
        )}
        <button
          className="button"
          onClick={async () => {
            await api("/auth/logout", {}).catch(() => {});
            location.reload();
          }}
        >
          <LogOut size={15} /> Sign out
        </button>
      </div>
    </section>
  );
}

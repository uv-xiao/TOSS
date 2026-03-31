import { useEffect, useState } from "react";
import { UiButton, UiCard, UiInput, UiSelect } from "@/components/ui";
import {
  deleteOrgGroupRoleMapping,
  getAdminAuthSettings,
  listOrgGroupRoleMappings,
  upsertAdminAuthSettings,
  upsertOrgGroupRoleMapping,
  type AdminAuthSettings,
  type OrgGroupRoleMapping,
  type ProjectRole
} from "@/lib/api";

export function AdminPage({ t }: { t: (key: string) => string }) {
  const defaultOrgId = "00000000-0000-0000-0000-000000000001";
  const roleOptions: Array<{ value: ProjectRole; label: string }> = [
    { value: "Owner", label: "Owner" },
    { value: "Teacher", label: "Manager" },
    { value: "TA", label: "Maintainer" },
    { value: "Student", label: "Contributor" },
    { value: "Viewer", label: "Viewer" }
  ];
  const [orgId, setOrgId] = useState(defaultOrgId);
  const [mappings, setMappings] = useState<OrgGroupRoleMapping[]>([]);
  const [groupName, setGroupName] = useState("");
  const [role, setRole] = useState<ProjectRole>("Student");
  const [settings, setSettings] = useState<AdminAuthSettings | null>(null);
  const [discoveryUrl, setDiscoveryUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const [groupMappings, authSettings] = await Promise.all([
        listOrgGroupRoleMappings(orgId),
        getAdminAuthSettings()
      ]);
      setMappings(groupMappings);
      setSettings(authSettings);
      setDiscoveryUrl(authSettings.oidc_issuer || "");
      setError(null);
    } catch (err) {
      setMappings([]);
      setSettings(null);
      setError(
        err instanceof Error
          ? err.message
          : "Unable to load admin settings. Organization admin permission required."
      );
    }
  }

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [orgId]);

  return (
    <section className="page">
      <h2>{t("admin.title")}</h2>
      <div className="card-list">
        <UiCard className="card">
          <strong>{t("admin.authSettings")}</strong>
          {settings ? (
            <>
              <UiInput
                value={settings.site_name || ""}
                onChange={(e) => setSettings({ ...settings, site_name: e.target.value })}
                placeholder={t("admin.siteName")}
              />
              <label>
                <input
                  type="checkbox"
                  checked={settings.allow_local_login}
                  onChange={(e) => setSettings({ ...settings, allow_local_login: e.target.checked })}
                />
                Allow local login
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={settings.allow_local_registration}
                  onChange={(e) =>
                    setSettings({ ...settings, allow_local_registration: e.target.checked })
                  }
                />
                Allow self registration
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={settings.allow_oidc}
                  onChange={(e) => setSettings({ ...settings, allow_oidc: e.target.checked })}
                />
                Allow OIDC
              </label>
              <UiSelect
                value={settings.anonymous_mode || "off"}
                onChange={(e) => setSettings({ ...settings, anonymous_mode: e.target.value })}
              >
                <option value="off">Off (everyone must log in)</option>
                <option value="read_only">Guest read-only</option>
                <option value="read_write_named">Guest read+write with self-identified name</option>
              </UiSelect>
              <UiInput
                value={discoveryUrl}
                onChange={(e) => setDiscoveryUrl(e.target.value)}
                placeholder="OIDC discovery URL or issuer URL"
              />
              <UiInput
                value={settings.oidc_client_id || ""}
                onChange={(e) => setSettings({ ...settings, oidc_client_id: e.target.value })}
                placeholder="OIDC client id"
              />
              <UiInput
                value={settings.oidc_client_secret || ""}
                onChange={(e) => setSettings({ ...settings, oidc_client_secret: e.target.value })}
                placeholder="OIDC client secret"
              />
              <UiInput
                value={settings.oidc_redirect_uri || ""}
                onChange={(e) => setSettings({ ...settings, oidc_redirect_uri: e.target.value })}
                placeholder="OIDC redirect URI"
              />
              <UiInput
                value={settings.oidc_groups_claim || "groups"}
                onChange={(e) => setSettings({ ...settings, oidc_groups_claim: e.target.value })}
                placeholder="OIDC groups claim"
              />
              <UiButton
                onClick={async () => {
                  if (!settings) return;
                  const updated = await upsertAdminAuthSettings({
                    allow_local_login: settings.allow_local_login,
                    allow_local_registration: settings.allow_local_registration,
                    allow_oidc: settings.allow_oidc,
                    anonymous_mode: settings.anonymous_mode || "off",
                    site_name: settings.site_name || null,
                    oidc_discovery_url: discoveryUrl || null,
                    oidc_client_id: settings.oidc_client_id || null,
                    oidc_client_secret: settings.oidc_client_secret || null,
                    oidc_redirect_uri: settings.oidc_redirect_uri || null,
                    oidc_groups_claim: settings.oidc_groups_claim || "groups"
                  });
                  setSettings(updated);
                }}
              >
                Save Auth Settings
              </UiButton>
            </>
          ) : (
            <span>{t("common.loading")}</span>
          )}
        </UiCard>

        <UiCard className="card">
          <strong>OIDC Group to Project Role Mapping</strong>
          <div className="toolbar">
            <UiInput value={orgId} onChange={(e) => setOrgId(e.target.value)} placeholder="Organization ID" />
            <UiInput
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="OIDC group"
            />
            <UiSelect value={role} onChange={(e) => setRole(e.target.value as ProjectRole)}>
              {roleOptions.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </UiSelect>
            <UiButton
              onClick={async () => {
                if (!groupName.trim()) return;
                await upsertOrgGroupRoleMapping(orgId, { group_name: groupName.trim(), role });
                setGroupName("");
                await refresh();
              }}
            >
              Save
            </UiButton>
          </div>
          <div className="card-list">
            {mappings.map((mapping) => (
              <div className="card" key={mapping.group_name}>
                <strong>{mapping.group_name}</strong>
                <span>{roleOptions.find((option) => option.value === mapping.role)?.label ?? mapping.role}</span>
                <UiButton
                  onClick={async () => {
                    await deleteOrgGroupRoleMapping(orgId, mapping.group_name);
                    await refresh();
                  }}
                >
                  Remove
                </UiButton>
              </div>
            ))}
          </div>
        </UiCard>
      </div>
      {error && <div className="error">{error}</div>}
    </section>
  );
}

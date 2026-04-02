import { useEffect, useState } from "react";
import { UiButton, UiCard, UiInput, UiSelect } from "@/components/ui";
import {
  createOrganization,
  listOrganizations,
  deleteOrgGroupRoleMapping,
  getAdminAuthSettings,
  listOrgGroupRoleMappings,
  upsertAdminAuthSettings,
  upsertOrgGroupRoleMapping,
  type AdminAuthSettings,
  type OrgGroupRoleMapping,
  type Organization,
  type OrganizationMembershipRole
} from "@/lib/api";

export function AdminPage({ t }: { t: (key: string) => string }) {
  const roleOptions: Array<{ value: OrganizationMembershipRole; label: string }> = [
    { value: "owner", label: "Owner" },
    { value: "member", label: "Member" }
  ];
  const [orgId, setOrgId] = useState("");
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [newOrganizationName, setNewOrganizationName] = useState("");
  const [mappings, setMappings] = useState<OrgGroupRoleMapping[]>([]);
  const [groupName, setGroupName] = useState("");
  const [role, setRole] = useState<OrganizationMembershipRole>("member");
  const [settings, setSettings] = useState<AdminAuthSettings | null>(null);
  const [discoveryUrl, setDiscoveryUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function refreshMappings(targetOrgId: string) {
    if (!targetOrgId) {
      setMappings([]);
      return;
    }
    const groupMappings = await listOrgGroupRoleMappings(targetOrgId);
    setMappings(groupMappings);
  }

  async function refresh() {
    try {
      const [orgs, authSettings] = await Promise.all([listOrganizations(), getAdminAuthSettings()]);
      const resolvedOrgId = orgId || orgs.organizations[0]?.id || "";
      setOrganizations(orgs.organizations);
      setOrgId(resolvedOrgId);
      await refreshMappings(resolvedOrgId);
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
  }, []);

  useEffect(() => {
    if (!orgId) return;
    refreshMappings(orgId)
      .catch(() => {
        setMappings([]);
      });
  }, [orgId]);

  async function saveAuthSettings() {
    if (!settings) return;
    const updated = await upsertAdminAuthSettings({
      allow_local_login: settings.allow_local_login,
      allow_local_registration: settings.allow_local_registration,
      allow_oidc: settings.allow_oidc,
      anonymous_mode: settings.anonymous_mode || "off",
      site_name: settings.site_name || null,
      announcement: settings.announcement || null,
      oidc_discovery_url: discoveryUrl || null,
      oidc_client_id: settings.oidc_client_id || null,
      oidc_client_secret: settings.oidc_client_secret || null,
      oidc_redirect_uri: settings.oidc_redirect_uri || null,
      oidc_groups_claim: settings.oidc_groups_claim || "groups"
    });
    setSettings(updated);
  }

  async function createOrganizationAction() {
    const name = newOrganizationName.trim();
    if (!name) return;
    await createOrganization({ name });
    setNewOrganizationName("");
    await refresh();
  }

  async function saveMapping() {
    if (!orgId || !groupName.trim()) return;
    await upsertOrgGroupRoleMapping(orgId, { group_name: groupName.trim(), role });
    setGroupName("");
    await refresh();
  }

  async function removeMapping(group: string) {
    await deleteOrgGroupRoleMapping(orgId, group);
    await refresh();
  }

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
              <UiInput
                value={settings.announcement || ""}
                onChange={(e) => setSettings({ ...settings, announcement: e.target.value })}
                placeholder="Login announcement banner message (optional)"
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
                onClick={saveAuthSettings}
              >
                Save Auth Settings
              </UiButton>
            </>
          ) : (
            <span>{t("common.loading")}</span>
          )}
        </UiCard>

        <UiCard className="card">
          <strong>Organizations</strong>
          <div className="toolbar">
            <UiInput
              value={newOrganizationName}
              onChange={(e) => setNewOrganizationName(e.target.value)}
              placeholder="Organization name"
            />
            <UiButton
              onClick={createOrganizationAction}
            >
              Create
            </UiButton>
          </div>
          <UiSelect value={orgId} onChange={(e) => setOrgId(e.target.value)} disabled={organizations.length === 0}>
            {organizations.length === 0 ? (
              <option value="">No organizations</option>
            ) : (
              organizations.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))
            )}
          </UiSelect>
        </UiCard>

        <UiCard className="card">
          <strong>OIDC Group to Organization Membership Mapping</strong>
          <div className="toolbar">
            <UiInput
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="OIDC group"
            />
            <UiSelect value={role} onChange={(e) => setRole(e.target.value as OrganizationMembershipRole)}>
              {roleOptions.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </UiSelect>
            <UiButton
              onClick={saveMapping}
              disabled={!orgId}
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
                  onClick={() => removeMapping(mapping.group_name)}
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

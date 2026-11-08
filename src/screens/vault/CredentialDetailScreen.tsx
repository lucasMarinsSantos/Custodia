// Detalhe da credencial: visualizar, copiar (limpeza em 30 s), mover, histórico e excluir
import React, { useMemo, useRef, useState } from 'react';
import {
  Alert,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  Badge,
  Banner,
  Button,
  Card,
  Chip,
  Icon,
  IconButton,
  KeyValue,
  Loading,
  Screen,
  Section,
  Sheet,
} from '../../components/ui';
import { ServiceIcon } from '../../components/widgets';
import { LifecycleBanners, PasswordHistoryCard, UsageInfo } from '../../components/lifecycle';
import { Colors, StrengthColors, StrengthTextColors, Type } from '../../theme';
import { useVaultData } from '../../context/AppState';
import { Repo } from '../../services/Repository';
import { Vault } from '../../services/VaultService';
import { ClipboardService } from '../../services/ClipboardService';
import { analyzeCached } from '../../services/AnalysisService';
import { IconService } from '../../services/IconService';
import { PasswordService } from '../../services/PasswordService';
import {
  CategoryLabels,
  Credential,
  Folder,
  PasswordStrength,
  StrengthLabels,
} from '../../types/models';
import { formatDate, hostnameOf, normalizeUrl, timeAgo } from '../../utils';
import { toast } from '../../services/events';
import { DRAG_MSG, DragService } from '../../services/DragService';
import { AssociatedSitesView } from '../../components/AssociatedSites';
import { FolderRulesBanner, useFolderGuard } from '../../components/ReauthPrompt';
import { PolicyService } from '../../services/PolicyService';

const LEVELS = ['critical', 'weak', 'medium', 'strong', 'very_strong'];

/** Toque longo: arrasta o usuário/senha para o outro app da tela dividida. */
async function dragField(c: Credential, field: 'username' | 'password') {
  try {
    await DragService.start(c, field);
  } catch (e: any) {
    const msg = e?.message || DRAG_MSG.failed;
    toast(msg, msg === DRAG_MSG.notMultiWindow ? 'info' : 'error');
  }
}

export default function CredentialDetailScreen({ navigation, route }: any) {
  const id: string = route.params?.id;
  const [data, , loading] = useVaultData(
    async () => ({
      cred: await Repo.credential(id),
      folders: await Repo.folders(),
    }),
    { cred: null as Credential | null, folders: [] as Folder[] },
    [id],
  );
  const [showPw, setShowPw] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [moveOpen, setMoveOpen] = useState(false);
  const c = data.cred;

  const analysis = useMemo(() => (c ? analyzeCached(c.password) : null), [c]);
  // Regras da pasta: reautenticar para ver/copiar e tempo de limpeza da área de transferência
  const policy = useMemo(() => (c ? PolicyService.forCredential(data.folders, c) : null), [c, data.folders]);
  const guard = useFolderGuard(policy);
  const guarded = guard.guarded;
  if (!c || !analysis) {
    return (
      <Screen title="Credencial" onBack={() => navigation.goBack()}>
        {loading ? (
          <Loading />
        ) : (
          <Banner tone="info" text="Esta credencial não existe mais." />
        )}
      </Screen>
    );
  }

  const folderPath = Repo.folderPath(data.folders, c.folderId);

  const copy = async (
    value: string,
    label: string,
    sensitive = true,
    countUse = false,
  ) => {
    try {
      if (sensitive && !(await guard.allow())) return;
      await ClipboardService.copy(value, label, sensitive, sensitive ? guard.clipboardSeconds() : undefined);
      if (countUse) await Repo.recordUsage(c.id);
    } catch (e: any) {
      toast(e?.message || 'Não foi possível copiar.', 'error');
    }
  };

  const remove = () =>
    Alert.alert(
      'Excluir credencial',
      `"${c.title}" e todo o seu histórico serão removidos permanentemente do cofre.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Excluir',
          style: 'destructive',
          onPress: async () => {
            // O diálogo do Android sobrevive ao bloqueio do cofre: só age se a sessão ainda estiver aberta
            if (!Vault.isUnlocked) return;
            try {
              await Repo.deleteCredential(c.id);
              toast('Credencial excluída', 'success');
              navigation.goBack();
            } catch (e: any) {
              toast(
                e?.message || 'Não foi possível excluir a credencial.',
                'error',
              );
            }
          },
        },
      ],
    );

  const move = async (folderId: string | null) => {
    if (!Vault.isUnlocked) return;
    if ((c.folderId || null) === folderId) {
      setMoveOpen(false);
      return;
    }
    try {
      await Repo.moveCredential(c.id, folderId);
      setMoveOpen(false);
      toast(
        folderId
          ? `Movida para ${Repo.folderPath(data.folders, folderId)}`
          : 'Removida da pasta',
        'success',
      );
    } catch (e: any) {
      toast(e?.message || 'Não foi possível mover a credencial.', 'error');
    }
  };

  return (
    <Screen
      title="Credencial"
      onBack={() => navigation.goBack()}
      right={
        <>
          <FavoriteButton credential={c} />
          <IconButton
            name="edit-2"
            onPress={() => guarded(() => navigation.navigate('CredentialEdit', { id: c.id }))}
            label="Editar"
          />
        </>
      }
    >
      <DetailHeader
        credential={c}
        strength={analysis.strength}
        folderPath={folderPath}
      />

      <WeakBanner strength={analysis.strength} password={c.password} />
      {/* validade e sugestão de troca */}
      <LifecycleBanners credential={c} folders={data.folders} onChangePassword={() => navigation.navigate('CredentialEdit', { id: c.id })} />

      <Card style={styles.fieldsCard}>
        <Field
          label="Usuário / e-mail"
          value={c.username || '—'}
          onCopy={
            c.username ? () => copy(c.username, 'Usuário', false) : undefined
          }
          onLongPress={() => dragField(c, 'username')}
        />
        <Field
          label="Senha"
          value={
            showPw
              ? c.password
              : '•'.repeat(Math.min(16, Math.max(8, c.password.length)))
          }
          hidden={!showPw}
          mono
          extra={
            <TouchableOpacity
              onPress={() => guard.toggle(showPw, setShowPw)}
              style={styles.fieldBtn}
              accessibilityRole="button"
              accessibilityLabel={showPw ? 'Ocultar senha' : 'Mostrar senha'}
            >
              <Icon
                name={showPw ? 'eye-off' : 'eye'}
                size={18}
                color={Colors.textSecondary}
              />
            </TouchableOpacity>
          }
          onCopy={() => copy(c.password, 'Senha', true, true)}
          copyLabel="Copiar senha"
          onLongPress={() => dragField(c, 'password')}
        />
        <StrengthBar strength={analysis.strength} />
        {c.url ? (
          <UrlField url={c.url} onCopy={() => copy(c.url, 'URL', false)} />
        ) : null}
        {c.customFields.map(f => (
          <CustomFieldRow
            key={f.id}
            field={f}
            revealed={!!revealed[f.id]}
            onToggle={() => guard.toggle(!!revealed[f.id], v => setRevealed(r => ({ ...r, [f.id]: v })))}
            onCopy={() =>
              copy(f.value, f.label || 'Campo', f.type === 'hidden')
            }
          />
        ))}
        <NotesBlock notes={c.notes} />
      </Card>

      <AssociatedSitesView credential={c} />
      <FolderRulesBanner policy={policy} />

      <Section title="Ações">
        <View style={styles.actions}>
          <Action
            icon="clock"
            label="Histórico"
            onPress={() => guarded(() => navigation.navigate('History', { id: c.id }))}
          />
          <Action
            icon="folder"
            label="Mover"
            onPress={() => guarded(() => setMoveOpen(true))}
          />
          <Action
            icon="edit-2"
            label="Editar"
            onPress={() => guarded(() => navigation.navigate('CredentialEdit', { id: c.id }))}
          />
          <Action
            icon="image"
            label="Atualizar logo"
            onPress={async () => {
              const logo = await IconService.refresh(c.url);
              toast(
                logo
                  ? 'Logo atualizado'
                  : 'Logo não encontrado (sem internet ou site sem ícone)',
                logo ? 'success' : 'info',
              );
            }}
          />
        </View>
      </Section>

      <Section title="Informações">
        <Card>
          <KeyValue label="Criada em" value={formatDate(c.createdAt, true)} />
          <KeyValue
            label="Última alteração"
            value={formatDate(c.updatedAt, true)}
          />
          <KeyValue
            label="Senha alterada em"
            value={formatDate(c.passwordChangedAt)}
          />
          <KeyValue label="Último acesso" value={timeAgo(c.lastUsedAt)} />
          {/* "Vezes utilizada", "Último uso", idade e validade */}
          <UsageInfo credential={c} folders={data.folders} />
        </Card>
      </Section>

      {/* últimas 10 senhas */}
      <PasswordHistoryCard credential={c} guard={guard} />

      <Button
        title="Excluir credencial"
        icon="trash-2"
        variant="danger"
        onPress={remove}
      />

      <Sheet
        visible={moveOpen}
        onClose={() => setMoveOpen(false)}
        title="Mover para pasta"
      >
        <View style={styles.wrap}>
          <Chip
            label="Sem pasta"
            active={!c.folderId}
            onPress={() => move(null)}
          />
          {data.folders.map(f => (
            <Chip
              key={f.id}
              label={Repo.folderPath(data.folders, f.id)}
              icon="folder"
              color={f.color}
              active={c.folderId === f.id}
              onPress={() => move(f.id)}
            />
          ))}
        </View>
        {data.folders.length === 0 ? (
          <Text style={[Type.small, styles.mt6]}>
            Crie pastas em Cofre › Pastas.
          </Text>
        ) : null}
      </Sheet>
      {guard.element}
    </Screen>
  );
}

function DetailHeader({
  credential: c,
  strength,
  folderPath,
}: {
  credential: Credential;
  strength: PasswordStrength;
  folderPath: string;
}) {
  return (
    <View style={styles.head}>
      <ServiceIcon credential={c} size={76} />
      <Text style={[Type.h1, styles.title]} accessibilityRole="header">
        {c.title}
      </Text>
      {c.url ? <Text style={Type.small}>{hostnameOf(c.url)}</Text> : null}
      <View style={styles.badges}>
        <Badge text={CategoryLabels[c.category]} icon="tag" />
        <Badge
          text={StrengthLabels[strength]}
          color={StrengthTextColors[strength]}
          bg={StrengthColors[strength] + '1A'}
          icon="shield"
        />
        {folderPath ? (
          <Badge
            text={folderPath}
            icon="folder"
            color={Colors.textSecondary}
            bg={Colors.divider}
          />
        ) : null}
      </View>
    </View>
  );
}

function StrengthBar({ strength }: { strength: PasswordStrength }) {
  const level = LEVELS.indexOf(strength);
  const color = StrengthColors[strength];
  return (
    <View style={styles.meter}>
      {[0, 1, 2, 3, 4].map(i => (
        <View
          key={i}
          style={[
            styles.meterSeg,
            { backgroundColor: i <= level ? color : Colors.border },
          ]}
        />
      ))}
    </View>
  );
}

function NotesBlock({ notes }: { notes?: string }) {
  if (!notes) return null;
  return (
    <View style={[styles.field, styles.noBorder]}>
      <View style={styles.flex}>
        <Text style={Type.label}>Notas</Text>
        <Text style={[Type.body, styles.mt6]} selectable>
          {notes}
        </Text>
      </View>
    </View>
  );
}

function FavoriteButton({ credential }: { credential: Credential }) {
  const busy = useRef(false);
  const toggle = async () => {
    if (busy.current || !Vault.isUnlocked) return;
    busy.current = true;
    try {
      await Repo.setFavorite(credential.id, !credential.favorite);
    } catch (e: any) {
      toast(e?.message || 'Não foi possível alterar o favorito.', 'error');
    } finally {
      busy.current = false;
    }
  };
  return (
    <IconButton
      name="star"
      color={credential.favorite ? Colors.gold : Colors.textSecondary}
      onPress={toggle}
      label={
        credential.favorite
          ? 'Remover dos favoritos'
          : 'Adicionar aos favoritos'
      }
      selected={!!credential.favorite}
    />
  );
}

function WeakBanner({
  strength,
  password,
}: {
  strength: PasswordStrength;
  password: string;
}) {
  if (strength !== 'critical' && strength !== 'weak') return null;
  const tips = PasswordService.analyze(password)
    .feedback.slice(0, 3)
    .join('; ');
  return (
    <Banner
      tone="warning"
      title="Senha Fraca"
      text={tips || 'Troque por uma senha gerada.'}
    />
  );
}

function UrlField({ url, onCopy }: { url: string; onCopy: () => void }) {
  // Só abre endereços web: intent://, file://, content:// etc. salvos no campo não são disparados
  const openable = /^https?:\/\//i.test(normalizeUrl(url));
  return (
    <Field
      label="Site / app"
      value={url}
      onCopy={onCopy}
      extra={
        openable ? (
          <TouchableOpacity
            onPress={() =>
              Linking.openURL(normalizeUrl(url)).catch(() =>
                toast('Não foi possível abrir o endereço', 'error'),
              )
            }
            style={styles.fieldBtn}
            accessibilityRole="link"
            accessibilityLabel={`Abrir ${hostnameOf(url)}`}
          >
            <Icon name="external-link" size={18} color={Colors.primary} />
          </TouchableOpacity>
        ) : undefined
      }
    />
  );
}

function CustomFieldRow({
  field,
  revealed,
  onToggle,
  onCopy,
}: {
  field: Credential['customFields'][number];
  revealed: boolean;
  onToggle: () => void;
  onCopy: () => void;
}) {
  const hidden = field.type === 'hidden';
  const masked = hidden && !revealed;
  const name = field.label || 'Campo';
  return (
    <Field
      label={name}
      value={masked ? '••••••••' : field.value}
      hidden={masked}
      extra={
        hidden ? (
          <TouchableOpacity
            onPress={onToggle}
            style={styles.fieldBtn}
            accessibilityRole="button"
            accessibilityLabel={`${revealed ? 'Ocultar' : 'Mostrar'} ${name}`}
          >
            <Icon
              name={revealed ? 'eye-off' : 'eye'}
              size={18}
              color={Colors.textSecondary}
            />
          </TouchableOpacity>
        ) : undefined
      }
      onCopy={onCopy}
    />
  );
}

function Field({
  label,
  value,
  onCopy,
  extra,
  mono,
  hidden,
  copyLabel,
  onLongPress,
}: {
  label: string;
  value: string;
  onCopy?: () => void;
  extra?: React.ReactNode;
  mono?: boolean;
  hidden?: boolean;
  copyLabel?: string;
  /** Toque longo: arrastar para outro app em tela dividida. */
  onLongPress?: () => void;
}) {
  return (
    <View style={styles.field}>
      <FieldBody label={label} value={value} hidden={hidden} mono={mono} onLongPress={onLongPress} />
      {extra}
      {onCopy ? (
        <TouchableOpacity
          onPress={onCopy}
          style={[styles.fieldBtn, styles.copyBtn]}
          accessibilityRole="button"
          accessibilityLabel={copyLabel || `Copiar ${label.toLowerCase()}`}
        >
          <Icon name="copy" size={17} color={Colors.primary} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

/** Rótulo e valor do campo. Com `onLongPress`, o toque longo inicia o arrastar (e a seleção de texto sai). */
function FieldBody({ label, value, hidden, mono, onLongPress }: { label: string; value: string; hidden?: boolean; mono?: boolean; onLongPress?: () => void }) {
  const a11yLabel = `${label}: ${hidden ? 'oculto' : value}`;
  const content = (
    <>
      <Text style={Type.label}>{label}</Text>
      <Text style={[mono ? Type.mono : Type.body, styles.fieldValue]} numberOfLines={3} selectable={!mono && !onLongPress}>
        {value}
      </Text>
    </>
  );
  if (!onLongPress) {
    return (
      <View style={styles.flex} accessible accessibilityLabel={a11yLabel}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      style={styles.flex}
      accessible
      accessibilityLabel={a11yLabel}
      accessibilityHint="Toque longo para arrastar para outro app em tela dividida"
      accessibilityActions={[{ name: 'longpress', label: 'Arrastar para outro app' }]}
      onAccessibilityAction={onLongPress}
      onLongPress={onLongPress}
    >
      {content}
    </Pressable>
  );
}

function Action({
  icon,
  label,
  onPress,
}: {
  icon: string;
  label: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={styles.action}
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View
        style={styles.actionIcon}
        importantForAccessibility="no-hide-descendants"
      >
        <Icon name={icon} size={19} color={Colors.primary} />
      </View>
      <Text style={[Type.caption, styles.actionText]} numberOfLines={1}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  head: { alignItems: 'center', marginBottom: 18 },
  title: { marginTop: 12, textAlign: 'center' },
  badges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 6,
    marginTop: 10,
  },
  fieldsCard: { paddingVertical: 4, marginBottom: 16 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider,
  },
  noBorder: { borderBottomWidth: 0 },
  flex: { flex: 1 },
  mt6: { marginTop: 6 },
  fieldValue: { marginTop: 5 },
  copyBtn: { backgroundColor: Colors.primarySoft },
  fieldBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 4,
  },
  meter: {
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: 2,
    paddingBottom: 10,
  },
  meterSeg: { flex: 1, height: 4, borderRadius: 2 },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    backgroundColor: Colors.surface,
    borderRadius: 16,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },
  action: { width: '25%', alignItems: 'center', paddingVertical: 8 },
  actionIcon: {
    width: 46,
    height: 46,
    borderRadius: 14,
    backgroundColor: Colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionText: { color: Colors.text, marginTop: 6, textAlign: 'center' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});

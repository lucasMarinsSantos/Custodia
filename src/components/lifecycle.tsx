// Componentes do ciclo de vida da credencial, usados no cofre, no detalhe e na edição:
//  •: validade (vencida → inativa, fora do preenchimento automático) e contador de uso visível
//  •: idade da senha e sugestão de troca pelo prazo (padrão de 90 dias, da credencial ou da pasta)
//  •: últimas 10 senhas, ocultas por padrão e copiáveis
// Ficam num arquivo próprio para que as telas compartilhadas recebam só uma linha de cada bloco.
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Badge, Banner, Button, Card, Chip, Icon, Input, KeyValue, ListCard, Section, ToggleRow } from './ui';
import { Colors, Type } from '../theme';
import { AttentionKind, EXPIRY_CHOICES, ExpiryService, MAX_AGE_CHOICES, MaxAgeSourceLabels } from '../services/ExpiryService';
import { ClipboardService } from '../services/ClipboardService';
import { Vault } from '../services/VaultService';
import { toast } from '../services/events';
import { Credential, Folder } from '../types/models';
import { formatDate, timeAgo } from '../utils';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// -----------------------------------------------------------------------------
// Lista do cofre
// -----------------------------------------------------------------------------

/** Marca da linha da lista: vencida (vermelho) ou senha para trocar (laranja). */
export function AttentionTag({ kind }: { kind: AttentionKind | null | undefined }) {
  if (!kind) return null;
  return kind === 'expired' ? (
    <Badge text="Vencida" icon="alert-octagon" color={Colors.danger} bg={Colors.dangerBg} />
  ) : (
    <Badge text="Trocar senha" icon="refresh-cw" color={Colors.warning} bg={Colors.warningBg} />
  );
}

/** Texto acessível da situação, acrescentado ao rótulo da linha. */
export const attentionA11y = (kind: AttentionKind | null | undefined) => {
  if (kind === 'expired') return 'vencida';
  return kind === 'old' ? 'senha para trocar' : null;
};

/** Aviso no topo do cofre quando há vencidas ou senhas antigas; toque aplica o filtro. */
export function AttentionBanner({ expired, old, onPress }: { expired: number; old: number; onPress: () => void }) {
  if (!expired && !old) return null;
  const parts = [expired ? plural(expired, 'credencial vencida', 'credenciais vencidas') : null, old ? plural(old, 'senha para trocar', 'senhas para trocar') : null].filter(Boolean);
  return (
    <Banner
      tone={expired ? 'danger' : 'warning'}
      icon={expired ? 'alert-octagon' : 'clock'}
      title={expired ? 'Senhas expiradas' : 'Recomendamos trocar estas senhas'}
      text={`${parts.join(' e ')}. Toque para ver.`}
      onPress={onPress}
    />
  );
}

// -----------------------------------------------------------------------------
// Detalhe da credencial
// -----------------------------------------------------------------------------

/** Avisos de validade e de troca no detalhe (com o atalho para trocar a senha). */
export function LifecycleBanners({ credential: c, folders, onChangePassword }: { credential: Credential; folders: Folder[]; onChangePassword: () => void }) {
  const state = ExpiryService.state(c);
  const rotation = ExpiryService.rotation(c, folders);
  return (
    <>
      {state === 'expired' ? (
        <Banner
          tone="danger"
          icon="alert-octagon"
          title="Credencial vencida"
          text={`${ExpiryService.expiryLabel(c)}. ${c.inactive ? 'Ela está inativa e não aparece no preenchimento automático. ' : ''}Troque a senha ou renove a validade para reativá-la.`}
        />
      ) : null}
      {state === 'expiring' ? <Banner tone="warning" icon="calendar" title="Validade próxima" text={`${ExpiryService.expiryLabel(c)} (${formatDate(c.expiresAt)}).`} /> : null}
      {state !== 'expired' && rotation.needsChange ? (
        <Banner
          tone="warning"
          icon="refresh-cw"
          title="Recomendamos trocar esta senha"
          text={`${ExpiryService.ageLabel(rotation.ageDays)} (prazo de ${rotation.maxAgeDays} dias, ${MaxAgeSourceLabels[rotation.source]}).`}
        />
      ) : null}
      {state === 'expired' || rotation.needsChange ? <Button title="Trocar senha" icon="refresh-cw" variant="secondary" small onPress={onChangePassword} style={styles.mb16} /> : null}
    </>
  );
}

/** "Vezes utilizada", "Último uso", idade e validade, no bloco de informações do detalhe. */
export function UsageInfo({ credential: c, folders }: { credential: Credential; folders: Folder[] }) {
  const rotation = ExpiryService.rotation(c, folders);
  return (
    <>
      <KeyValue label="Vezes utilizada" value={String(c.usageCount || 0)} />
      <KeyValue label="Último uso" value={c.lastUsageAt ? timeAgo(c.lastUsageAt) : 'Nunca utilizada'} />
      <KeyValue label="Idade da senha" value={ExpiryService.ageLabel(rotation.ageDays)} />
      <KeyValue label="Prazo para trocar" value={`${rotation.maxAgeDays} dias (${MaxAgeSourceLabels[rotation.source]})`} />
      <KeyValue label="Validade" value={c.expiresAt ? `${formatDate(c.expiresAt)} • ${ExpiryService.expiryLabel(c)}` : 'Sem data de validade'} />
      <KeyValue label="Situação" value={ExpiryService.isActive(c) ? 'Ativa' : 'Inativa (fora do preenchimento automático)'} />
    </>
  );
}

/** Últimas 10 senhas: ocultas por padrão, cada uma pode ser mostrada e copiada. */
/** Regra da pasta: reautenticação antes de mostrar/copiar e tempo de limpeza da área de transferência. */
export interface HistoryGuard {
  allow: () => Promise<boolean>;
  clipboardSeconds: () => number | undefined;
}

export function PasswordHistoryCard({ credential: c, guard }: { credential: Credential; guard?: HistoryGuard }) {
  const [shown, setShown] = useState<Record<number, boolean>>({});
  // Some ao bloquear/trocar de credencial: nada fica revelado por engano
  useEffect(() => setShown({}), [c.id]);
  const copy = async (password: string) => {
    if (!Vault.isUnlocked) return;
    try {
      if (guard && !(await guard.allow())) return;
      await ClipboardService.copy(password, 'Senha anterior', true, guard?.clipboardSeconds());
    } catch (e: any) {
      toast(e?.message || 'Não foi possível copiar a senha.', 'error');
    }
  };
  // Esconder é livre; mostrar passa pela regra da pasta
  const reveal = async (i: number) => {
    if (!shown[i] && guard && !(await guard.allow())) return;
    setShown(s => ({ ...s, [i]: !s[i] }));
  };
  const list = c.passwordHistory || [];
  return (
    <Section title={`Senhas anteriores (${list.length}/10)`}>
      {list.length === 0 ? (
        <Text style={Type.small}>Nenhuma senha anterior. Quando você trocar a senha, a antiga fica guardada aqui.</Text>
      ) : (
        <Card style={styles.historyCard}>
          {list.map((h, i) => (
            <View key={`${h.changedAt}-${i}`} style={[styles.historyRow, i === list.length - 1 && styles.noBorder]}>
              <View style={styles.flex} accessible accessibilityLabel={`Senha anterior ${i + 1}, usada até ${formatDate(h.changedAt)}: ${shown[i] ? h.password : 'oculta'}`}>
                <Text style={[Type.mono, styles.historyValue]} numberOfLines={2}>
                  {shown[i] ? h.password : '••••••••••'}
                </Text>
                <Text style={Type.caption}>Usada até {formatDate(h.changedAt, true)}</Text>
              </View>
              <TouchableOpacity
                onPress={() => reveal(i)}
                style={styles.iconBtn}
                accessibilityRole="button"
                accessibilityLabel={`${shown[i] ? 'Ocultar' : 'Mostrar'} senha anterior ${i + 1}`}
              >
                <Icon name={shown[i] ? 'eye-off' : 'eye'} size={18} color={Colors.textSecondary} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => copy(h.password)} style={[styles.iconBtn, styles.copyBtn]} accessibilityRole="button" accessibilityLabel={`Copiar senha anterior ${i + 1}`}>
                <Icon name="copy" size={17} color={Colors.primary} />
              </TouchableOpacity>
            </View>
          ))}
        </Card>
      )}
    </Section>
  );
}

// -----------------------------------------------------------------------------
// Edição da credencial
// -----------------------------------------------------------------------------

type ExpiryPatch = Pick<Credential, 'expiresAt' | 'maxPasswordAgeDays'>;

/**
 * Bloco "Validade e troca" da edição. A data digitada só é aplicada quando é válida; enquanto estiver inválida,
 * `onInvalid(true)` avisa a tela para não salvar (a mensagem aparece no próprio campo).
 */
export function ExpiryEditor({ credential: c, onChange, onInvalid }: { credential: Credential; onChange: (patch: Partial<ExpiryPatch>) => void; onInvalid: (invalid: boolean) => void }) {
  const [enabled, setEnabled] = useState(!!c.expiresAt);
  const [text, setText] = useState(ExpiryService.toInput(c.expiresAt));
  const [error, setError] = useState<string | null>(null);

  const applyText = (t: string) => {
    setText(t);
    const iso = ExpiryService.parseDate(t);
    const err = iso ? null : 'Data inválida (use DD/MM/AAAA)';
    setError(err);
    onInvalid(!!err);
    if (iso) onChange({ expiresAt: iso });
  };
  const pick = (days: number) => {
    const iso = ExpiryService.addDays(days);
    setText(ExpiryService.toInput(iso));
    setError(null);
    onInvalid(false);
    onChange({ expiresAt: iso });
  };
  const toggle = (v: boolean) => {
    setEnabled(v);
    if (v) pick(90);
    else {
      setError(null);
      onInvalid(false);
      onChange({ expiresAt: null });
    }
  };

  return (
    <Section title="Validade e troca">
      {c.inactive ? <Banner tone="danger" icon="alert-octagon" title="Credencial inativa" text="Venceu e está fora do preenchimento automático. Troque a senha ou mude a data de validade para reativá-la." /> : null}
      <ListCard style={styles.mb10}>
        <ToggleRow icon="calendar" title="Expirar em" subtitle={c.expiresAt ? ExpiryService.expiryLabel(c) : 'Sem data de validade'} value={enabled} onChange={toggle} last />
      </ListCard>
      {enabled ? (
        <>
          <View style={styles.wrap}>
            {EXPIRY_CHOICES.map(d => (
              <Chip key={d} label={`${d} dias`} active={!!c.expiresAt && ExpiryService.daysLeft(c) === d} onPress={() => pick(d)} />
            ))}
          </View>
          <Input label="Data de validade" icon="calendar" value={text} onChangeText={applyText} placeholder="DD/MM/AAAA" keyboardType="numbers-and-punctuation" maxLength={10} error={error} containerStyle={styles.mt10} />
        </>
      ) : null}
      <Text style={[Type.label, styles.mv10]}>Prazo para trocar a senha</Text>
      <View style={styles.wrap}>
        <Chip label={`Padrão (${Vault.settings.passwordMaxAgeDays || 90} dias)`} active={!c.maxPasswordAgeDays} onPress={() => onChange({ maxPasswordAgeDays: null })} />
        {MAX_AGE_CHOICES.map(d => (
          <Chip key={d} label={`${d} dias`} active={c.maxPasswordAgeDays === d} onPress={() => onChange({ maxPasswordAgeDays: d })} />
        ))}
      </View>
    </Section>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  mb10: { marginBottom: 10 },
  mb16: { marginBottom: 16 },
  mt10: { marginTop: 10 },
  mv10: { marginVertical: 10 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  historyCard: { paddingVertical: 4 },
  historyRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: Colors.divider },
  historyValue: { marginBottom: 2 },
  noBorder: { borderBottomWidth: 0 },
  iconBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', marginLeft: 4 },
  copyBtn: { backgroundColor: Colors.primarySoft },
});

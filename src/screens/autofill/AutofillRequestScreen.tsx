// Escolha da credencial para preencher em outro app
// Aberta pelo balão do Custódia: o usuário desbloqueia, escolhe a credencial (ou o cartão, endereço, identidade)
// e o app devolve só aquele par ao serviço de acessibilidade, que preenche ao voltar para o app de destino.
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { Banner, Button, EmptyState, Input, ListCard, Loading, Row, Screen, Section } from '../../components/ui';
import { Type } from '../../theme';
import { useVaultData } from '../../context/AppState';
import { AutofillService, Candidate, describeTarget } from '../../services/AutofillService';
import { Repo } from '../../services/Repository';
import { toast } from '../../services/events';
import { AutofillKind, AutofillRequest } from '../../native/integration';
import { Credential, FormItem } from '../../types/models';
import { MatchKind } from '../../services/DomainService';
import { stripAccents } from '../../utils';
import { SessionService } from '../../services/SessionService';

const FILL_ERROR = 'Não foi possível preencher.';

const MATCH_LABEL: Record<MatchKind, string> = {
  exact: 'Site salvo',
  subdomain: 'Subdomínio do site salvo',
  associated: 'Domínio associado',
  package: 'App associado',
};

const KIND_TITLE: Record<AutofillKind, string> = {
  login: 'Escolha o login',
  card: 'Escolha o cartão',
  address: 'Escolha o endereço',
  identity: 'Escolha a identidade',
};

function formSubtitle(f: FormItem): string {
  if (f.kind === 'card') return `•••• ${f.number.replace(/\D/g, '').slice(-4)} • ${f.expMonth}/${f.expYear}`;
  if (f.kind === 'address') return [f.street, f.city].filter(Boolean).join(', ');
  return f.email || f.fullName;
}

export default function AutofillRequestScreen({ navigation }: any) {
  const [req] = useState<AutofillRequest | null>(() => AutofillService.currentRequest);
  const [data, , loading] = useVaultData(
    async () => ({ preview: await AutofillService.preview(req), forms: req ? await AutofillService.formsFor(req.kind) : [], all: await Repo.credentials() }),
    { preview: { candidates: [] as Candidate[] } as Awaited<ReturnType<typeof AutofillService.preview>>, forms: [] as FormItem[], all: [] as Credential[] },
    [req?.id],
  );
  const [searching, setSearching] = useState(false);

  // Escolher a credencial não conta como inatividade: o cofre não bloqueia no meio do preenchimento
  useEffect(() => {
    SessionService.holdInactivity(true);
    return () => SessionService.holdInactivity(false);
  }, []);

  const close = async () => {
    try {
      await AutofillService.dismiss(req);
    } catch (e: any) {
      toast(e?.message || 'Não foi possível cancelar o pedido.', 'error');
    }
    navigation.goBack();
  };

  if (!req) {
    return (
      <Screen title="Preenchimento automático" onBack={() => navigation.goBack()}>
        <EmptyState icon="edit-3" title="Nenhum pedido de preenchimento aberto" message="Toque no balão do Custódia na tela de login do outro app." />
      </Screen>
    );
  }

  const target = describeTarget(req);
  const done = () => {
    toast(`Volte para ${target}: os campos serão preenchidos`, 'success');
    navigation.goBack();
  };

  const fillLogin = async (credId: string) => {
    const r = await AutofillService.fillLogin(req, credId);
    if (r.warning) toast(r.warning, 'info');
    done();
  };

  const fillForm = async (item: FormItem) => {
    await AutofillService.fillForm(req, item);
    done();
  };

  /** Credencial de fora da lista: associa o app/site do pedido a ela e preenche. */
  const associateAndFill = (c: Credential) =>
    Alert.alert('Associar e preencher?', `"${target}" será associado à credencial "${c.title}" e preenchido agora.`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Associar',
        onPress: async () => {
          try {
            await AutofillService.associate(req, c.id);
            await fillLogin(c.id);
          } catch (e: any) {
            toast(e?.message || FILL_ERROR, 'error');
          }
        },
      },
    ]);

  return (
    <Screen title={`Preencher em ${target}`} subtitle={KIND_TITLE[req.kind]} onBack={close} footer={<Button title="Cancelar" variant="outline" onPress={close} />}>
      {loading ? <Loading /> : null}
      {data.preview.blocked ? <Banner tone="danger" icon="alert-octagon" title="Preenchimento bloqueado" text={data.preview.blocked} /> : null}
      {data.preview.warning ? <Banner tone="warning" text={data.preview.warning} /> : null}
      {req.newPassword ? <Banner tone="info" text="Esta tela parece ser de troca de senha. Depois de trocar, atualize a credencial no Custódia." /> : null}
      {!data.preview.blocked && req.kind === 'login' ? (
        <LoginChoices candidates={data.preview.candidates} onFill={fillLogin} searching={searching} onSearch={() => setSearching(true)} all={data.all} onPickOther={associateAndFill} />
      ) : null}
      {!data.preview.blocked && req.kind !== 'login' ? <FormChoices forms={data.forms} onFill={fillForm} /> : null}
    </Screen>
  );
}

function LoginChoices({
  candidates,
  onFill,
  searching,
  onSearch,
  all,
  onPickOther,
}: {
  candidates: Candidate[];
  onFill: (id: string) => Promise<void>;
  searching: boolean;
  onSearch: () => void;
  all: Credential[];
  onPickOther: (c: Credential) => void;
}) {
  const run = (id: string) => onFill(id).catch((e: any) => toast(e?.message || FILL_ERROR, 'error'));
  return (
    <>
      {candidates.length ? (
        <Section title="Credenciais sugeridas">
          <ListCard>
            {candidates.map((c, i) => (
              <Row
                key={c.cred.id}
                icon="key"
                title={c.cred.title}
                subtitle={c.blockedReason || `${c.cred.username || 'sem usuário'} • ${MATCH_LABEL[c.match]}`}
                onPress={c.blockedReason ? () => toast(c.blockedReason!, 'error') : () => run(c.cred.id)}
                disabled={!!c.blockedReason}
                chevron
                last={i === candidates.length - 1}
              />
            ))}
          </ListCard>
        </Section>
      ) : (
        <Text style={[Type.body, styles.mb12]}>Nenhuma credencial salva para este app ou site.</Text>
      )}
      {searching ? <VaultSearch all={all} exclude={candidates.map(c => c.cred.id)} onPick={onPickOther} /> : <Button title="Buscar no cofre" icon="search" variant="secondary" onPress={onSearch} />}
    </>
  );
}

function VaultSearch({ all, exclude, onPick }: { all: Credential[]; exclude: string[]; onPick: (c: Credential) => void }) {
  const [q, setQ] = useState('');
  const results = useMemo(() => {
    const norm = (s: string) => stripAccents(s).toLowerCase();
    const term = norm(q.trim());
    return all.filter(c => !exclude.includes(c.id) && !c.inactive && (!term || norm(`${c.title} ${c.username} ${c.url}`).includes(term))).slice(0, 30);
  }, [all, exclude, q]);
  return (
    <Section title="Buscar no cofre">
      <Input label="Buscar" icon="search" value={q} onChangeText={setQ} placeholder="Nome, usuário ou site" autoCapitalize="none" maxLength={256} />
      <ListCard>
        {results.length ? (
          results.map((c, i) => <Row key={c.id} icon="key" title={c.title} subtitle={c.username || c.url} onPress={() => onPick(c)} chevron last={i === results.length - 1} />)
        ) : (
          <View style={styles.pad}>
            <Text style={Type.small}>Nada encontrado.</Text>
          </View>
        )}
      </ListCard>
    </Section>
  );
}

function FormChoices({ forms, onFill }: { forms: FormItem[]; onFill: (f: FormItem) => Promise<void> }) {
  if (!forms.length) return <EmptyState icon="credit-card" title="Nenhum item salvo deste tipo" message="Cadastre cartões, endereços e identidades em Cofre › Formulários." />;
  return (
    <Section title="Salvos no cofre">
      <ListCard>
        {forms.map((f, i) => (
          <Row
            key={f.id}
            icon={f.kind === 'card' ? 'credit-card' : f.kind === 'address' ? 'map-pin' : 'user'}
            title={f.label}
            subtitle={formSubtitle(f)}
            onPress={() => onFill(f).catch((e: any) => toast(e?.message || FILL_ERROR, 'error'))}
            chevron
            last={i === forms.length - 1}
          />
        ))}
      </ListCard>
    </Section>
  );
}

const styles = StyleSheet.create({
  mb12: { marginBottom: 12 },
  pad: { padding: 14 },
});

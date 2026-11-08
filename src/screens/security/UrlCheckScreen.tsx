// Verificação de site: anti-phishing (domínio parecido, punycode, IP, "@") e certificado SSL/TLS
// O endereço é analisado no aparelho; só o nome do host vai para o módulo nativo, que confere o certificado.
import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Badge, Banner, Button, Card, Icon, Input, Screen, Section } from '../../components/ui';
import { Colors, Type } from '../../theme';
import { Repo } from '../../services/Repository';
import { MAX_URL_LENGTH, SiteLevelLabels, SiteReason, SiteReport, UrlCheckService, UrlInputError } from '../../services/UrlCheckService';
import { toast } from '../../services/events';
import { formatDate } from '../../utils';

const LEVEL_STYLE = {
  safe: { color: Colors.success, bg: Colors.successBg, icon: 'shield' },
  warning: { color: Colors.warning, bg: Colors.warningBg, icon: 'alert-triangle' },
  danger: { color: Colors.danger, bg: Colors.dangerBg, icon: 'alert-octagon' },
};

const REASON_STYLE: Record<SiteReason['level'], { color: string; icon: string }> = {
  ok: { color: Colors.success, icon: 'check-circle' },
  info: { color: Colors.info, icon: 'info' },
  warning: { color: Colors.warning, icon: 'alert-triangle' },
  danger: { color: Colors.danger, icon: 'x-circle' },
};

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detail} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text style={Type.small}>{label}</Text>
      <Text style={[Type.bodyStrong, styles.detailValue]} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

function CertificateCard({ report }: { report: SiteReport }) {
  const tls = report.tls;
  if (!tls?.reachable) return null;
  return (
    <Section title="Certificado SSL">
      <Card>
        <Detail label="Certificado" value={tls.valid ? 'Válido' : 'Inválido' + (tls.error ? ` (${tls.error})` : '')} />
        {tls.issuer ? <Detail label="Emissor" value={tls.issuer} /> : null}
        {tls.validTo ? <Detail label="Expira em" value={formatDate(new Date(tls.validTo).toISOString())} /> : null}
        {tls.protocol ? <Detail label="Protocolo" value={tls.protocol} /> : null}
        <Detail label="HTTPS obrigatório (HSTS)" value={tls.hsts ? 'Sim' : 'Não'} />
      </Card>
    </Section>
  );
}

function ReportView({ report }: { report: SiteReport }) {
  const lv = LEVEL_STYLE[report.level];
  return (
    <>
      <Card style={[styles.verdict, { backgroundColor: lv.bg, borderColor: lv.color }]} accessibilityLabel={`${SiteLevelLabels[report.level]}: ${report.host}`}>
        <Icon name={lv.icon} size={28} color={lv.color} />
        <View style={styles.flex}>
          <Text style={[Type.h3, { color: lv.color }]}>{SiteLevelLabels[report.level]}</Text>
          <Text style={Type.small} numberOfLines={2}>
            {report.host}
          </Text>
        </View>
        {report.domain && report.domain !== report.host ? <Badge text={report.domain} /> : null}
      </Card>
      {report.similarTo ? <Banner tone="danger" title="Domínio parecido com um conhecido" text={`Este endereço imita ${report.similarTo}. Não digite senhas nele.`} /> : null}
      <Section title="O que foi verificado">
        <Card>
          {report.reasons.map(r => (
            <View key={r.text} style={styles.reason}>
              <Icon name={REASON_STYLE[r.level].icon} size={16} color={REASON_STYLE[r.level].color} />
              <Text style={[Type.small, styles.flex]}>{r.text}</Text>
            </View>
          ))}
          {report.reasons.length === 0 ? <Text style={Type.small}>Nenhum problema encontrado no endereço.</Text> : null}
        </Card>
      </Section>
      <CertificateCard report={report} />
    </>
  );
}

export default function UrlCheckScreen({ navigation, route }: any) {
  const [url, setUrl] = useState<string>(route?.params?.url || '');
  const [error, setError] = useState<string | undefined>();
  const [report, setReport] = useState<SiteReport | null>(null);
  const [busy, setBusy] = useState(false);

  const check = async () => {
    setError(undefined);
    setBusy(true);
    try {
      // Os sites já salvos no cofre servem de referência: um domínio parecido com um deles é suspeito
      const trusted = (await Repo.credentials()).map(c => c.url).filter(Boolean);
      setReport(await UrlCheckService.check(url, trusted));
    } catch (e: any) {
      setReport(null);
      if (e instanceof UrlInputError) setError(e.message);
      else toast(e?.message || 'Não foi possível verificar o site', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Verificar site" onBack={() => navigation.goBack()}>
      <Text style={[Type.small, styles.intro]}>
        Confira se um endereço é seguro antes de digitar uma senha: HTTPS, certificado (validade e emissor) e domínios que imitam sites conhecidos.
      </Text>
      <Input
        label="Endereço do site"
        icon="globe"
        value={url}
        onChangeText={t => {
          setUrl(t);
          setError(undefined);
        }}
        placeholder="https://exemplo.com.br"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        maxLength={MAX_URL_LENGTH}
        error={error}
        onSubmitEditing={check}
        returnKeyType="go"
      />
      <Button icon="shield" title="Verificar" onPress={check} loading={busy} disabled={busy} style={styles.mb16} />
      {report ? <ReportView report={report} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  intro: { marginBottom: 14 },
  mb16: { marginBottom: 16 },
  verdict: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, marginBottom: 12 },
  reason: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 6 },
  detail: { paddingVertical: 6 },
  detailValue: { marginTop: 2 },
});

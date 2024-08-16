import { identity, pipe } from 'fp-ts/lib/function'
import{ makeMatch } from 'ts-adt/MakeADT'
import * as TE from 'fp-ts/TaskEither';
import * as A from "fp-ts/Array";
import * as E from 'fp-ts/Either'
import * as t from 'io-ts'

const invoicesURL = 'https://recruiting.api.bemmbo.com/v2/invoices/pending';
const dollarInCLP = 800

const Payment = t.type({
    id: t.string,
    amount: t.number,
    status: t.string,
})

const Invoice = t.type({
    id: t.string,
    amount: t.number,
    organization_id: t.string,
    currency: t.string,
    type: t.string,
    payments: t.union([t.array(Payment), t.undefined])
})

const Invoices = t.array(Invoice)

const OrgSettings = t.type({
    organization_id: t.string,
    currency: t.string,
})

type Payment = t.TypeOf<typeof Payment>
type Invoice = t.TypeOf<typeof Invoice>
type Invoices = t.TypeOf<typeof Invoices>
type OrgSettings = t.TypeOf<typeof OrgSettings>

type FetchError = {
    type: 'FetchError'
    error: Error
}

type JSONParseError = {
    type: 'JSONParseError'
    error: Error
}

type SchemaParseError = {
    type: 'SchemaParseError'
    error: Error
}


const fetchAPI = TE.tryCatchK(
    (url: string) => fetch(url),
    (err): FetchError => ({
        type: 'FetchError',
        error: (err instanceof Error ? err : new Error('unexpected error when fetching data'))
    })
);

const getResponseAsJson = TE.tryCatchK(
    (body: Response) => body.json(),
    (err): JSONParseError => ({
        type: 'JSONParseError',
        error: (err instanceof Error ? err : new Error('unexpected error when parsing json'))
    })
)


const parseSchema = <T>(content: any, schema: t.Decoder<Record<string, any>, T>) => pipe(
    content,
    schema.decode,
    E.foldW(
        () => TE.left({
            type: 'SchemaParseError',
            error: new Error('json does not contain the requested schema')
        }),
        (data) => TE.right(data),
    )
)

const getOrganizationCurrency = async (organization_id: string) => {
    const orgUrl = `https://recruiting.api.bemmbo.com/organization/${organization_id}/settings`
    const getOrgSettings = pipe(
        orgUrl,
        fetchAPI,
        TE.flatMap(getResponseAsJson),
        TE.flatMap((maybeOrgSettings) => parseSchema(maybeOrgSettings, OrgSettings)),
    )
    const orgSettings = await getOrgSettings()
    if (E.isLeft(orgSettings)) {
        return "UNKNOWN"
    }
    return orgSettings.right.currency
}

const normalizePayment = (payment: Payment, factor: number) => {
    payment.amount = Math.round(payment.amount * factor)
    return payment
}

const normalizeCurrency = (inv: Invoice) => TE.tryCatch( async () => {
    const currency = await getOrganizationCurrency(inv.organization_id)
    if (currency === inv.currency) {
        return inv
    }
    switch (currency) {
        case "CLP": // USD to CLP
            inv.amount = inv.amount * dollarInCLP
            if (inv.payments) {
                inv.payments = inv.payments.map((pm) => normalizePayment(pm, dollarInCLP))
            }
            return inv
        case "USD": // CLP to USD
            inv.amount = Math.round(inv.amount / dollarInCLP)
            if (inv.payments) {
                inv.payments = inv.payments.map((pm) => normalizePayment(pm, 1/dollarInCLP))
            }
            return inv
        default:
            return inv
    }
}, (err) => err)

const secondTestMain = async () => {
    const getData = pipe(
        invoicesURL,
        fetchAPI,
        TE.flatMap(getResponseAsJson),
        TE.flatMap((invs) => parseSchema(invs, Invoices)),
    )

    const fetchedData = await getData()
    if(E.isLeft(fetchedData)){
        return
    }
    const invoices = fetchedData.right
    console.log(invoices)
    const normalizedInvoices = await pipe(invoices, A.map(normalizeCurrency), A.sequence(TE.ApplicativeSeq))()
    console.log(normalizedInvoices)
}
secondTestMain()


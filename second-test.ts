import { pipe } from 'fp-ts/lib/function'
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
    reference: t.union([t.string, t.undefined]),
    payments: t.union([t.array(Payment), t.undefined]),
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

type POSTError = {
    type: 'POSTError'
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
)

const sendPOST = TE.tryCatchK(
    (url: string, stringifiedData: string) => fetch(
        url, {
            method: 'POST',
            body: stringifiedData,
        }
    ),
    (err): POSTError => ({
        type: 'POSTError',
        error: (err instanceof Error ? err : new Error('unexpected error when sending POST request'))
    })
)

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

const getOrganizationCurrency = (organization_id: string) => pipe(
    organization_id,
    (oId) => `https://recruiting.api.bemmbo.com/organization/${oId}/settings`,
    fetchAPI,
    TE.flatMap(getResponseAsJson),
    TE.flatMap((maybeOrgSettings) => parseSchema(maybeOrgSettings, OrgSettings)),
    TE.map((settings) => settings.currency)
)

const normalizePayment = (payment: Payment, factor: number) => {
    payment.amount = Math.round(payment.amount * factor)
    return payment
}

const normalizeCurrency = (inv: Invoice) => TE.tryCatch( async () => {
    const currencyOut = await getOrganizationCurrency(inv.organization_id)()
    if (E.isLeft(currencyOut)) {
        return inv
    }
    const currency = currencyOut.right;
    if (currency === inv.currency) {
        return inv
    }
    switch (currency) {
        case "CLP": // USD to CLP
            return {...inv,
                amount: inv.amount * dollarInCLP,
                payments: inv.payments ? inv.payments.map((pm) => normalizePayment(pm, dollarInCLP)) : undefined,
            }
        case "USD": // CLP to USD
            return { ...inv, 
                amount: Math.round(inv.amount / dollarInCLP),
                payments: inv.payments ? inv.payments.map((pm) => normalizePayment(pm, 1/dollarInCLP)) : undefined,
            }
        default:
            return inv
    }
}, (err) => err)

const payPayment = () => true // declare payment as paid

const secondTestMain = async () => {
    const getData = pipe(
        invoicesURL,
        fetchAPI,
        TE.flatMap(getResponseAsJson),
        TE.flatMap((invs) => parseSchema(invs, Invoices)),
        TE.flatMap((invoices) => pipe(invoices, A.map(normalizeCurrency), A.sequence(TE.ApplicativeSeq)))
    )

    const fetchedData = await getData()
    if(E.isLeft(fetchedData)){ // On error, return
        return
    }

    const invoices = fetchedData.right
    const receivedInvs = invoices.filter((inv) => inv.type === 'received')
    const creditNotes = invoices.filter((inv) => inv.type === 'credit_note')

    for (let i = 0; i < receivedInvs.length; i++) {
        const invoice = receivedInvs[i]
        if (!invoice.payments) {
            continue
        }
        const creditNotesForInvoice = creditNotes.filter((cn) => cn.reference === invoice.id)
        let amountToReduce = creditNotesForInvoice.reduce((acc, cn) => acc + cn.amount, 0)
        invoice.payments.sort((inv1, inv2) => inv1.amount - inv2.amount)

        for (let j = 0; j < invoice.payments.length; j++) {
            const payment = invoice.payments[j]
            if (payment.status === 'paid') {
                continue // nothing to do
            } else if (amountToReduce >= payment.amount) {
                amountToReduce -= payment.amount
                // pay 0
            } else {
                const amountToPay = payment.amount - amountToReduce
                amountToReduce = 0
                // pay discounted payment
            }
        }
        console.log(`Reducing ${amountToReduce} to invoice ${invoice.id}`)
    }
}
secondTestMain()


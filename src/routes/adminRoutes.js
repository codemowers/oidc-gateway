import Router from "koa-router";
import {koaBody as bodyParser} from "koa-body";
import Account, {GroupPrefix} from "../support/account.js";
import {GitHubGroupPrefix} from "../support/kube-constants.js";
import {signedInToSelf} from "../support/signed-in.js";
import {auditLog} from "../support/audit-log.js";

export default (provider) => {
    const router = new Router();

    router.use(bodyParser({ json: true }))
    router.use(async (ctx, next) => {
        let session = await ctx.sessionService.getAdminSession(ctx)
        if (session) {
            ctx.adminSession = session
            return next()
        } else {
            const session = await signedInToSelf(ctx, provider)
            if (session) {
                if (ctx.currentAccount.isAdmin) {
                    ctx.adminSession = session
                    await ctx.sessionService.setAdminSession(ctx, session)
                    auditLog(ctx, {}, 'Admin session granted')
                    return next()
                }
            }
        }
    })

    router.get('/admin', async (ctx, next) => {
        return ctx.render('frontend', { layout: false, title: 'oidc-gateway' })
    })

    router.get('/admin/api/metadata', async (ctx, next) => {
        ctx.body = {
            groupPrefix: GroupPrefix,
        }
    })

    router.get('/admin/api/accounts', async (ctx, next) => {
        let accounts = await ctx.kubeOIDCUserService.listUsers()
        ctx.body = {
            accounts: accounts.map((acc) => acc.getProfileResponse(true, ctx.adminSession.accountId))
        }
    })

    router.post('/admin/api/accounts/:accountId', async (ctx, next) => {
        const accountId = ctx.request.params.accountId
        const body = ctx.request.body
        await ctx.kubeOIDCUserService.updateUserSpec({
            accountId,
            customProfile: {
                name: body.name,
                company: body.company,
            },
            customGroups: body.groups.filter(g => g.name).filter(g => g.prefix !== GitHubGroupPrefix)
                .filter((val, index, self) => {return self.findIndex((g) => {return g.name === val.name && g.prefix === val.prefix}) === index}),
        })
        auditLog(ctx, {accountId, body}, 'Admin updated user')
        let accounts = await ctx.kubeOIDCUserService.listUsers()
        ctx.body = {
            accounts: accounts.map((acc) => acc.getProfileResponse(true))
        }
    })

    router.get('/admin/api/account/impersonation', async (ctx, next) => {
        ctx.body = {
            impersonation: await ctx.sessionService.getImpersonation(ctx)
        }
    })

    router.post('/admin/api/account/impersonation', async (ctx, next) => {
        const accountId = ctx.request.body.accountId
        const impersonation = await ctx.sessionService.impersonate(ctx, accountId)
        auditLog(ctx, {accountId}, 'Admin enabled impersonation')
        ctx.body = {
            impersonation
        }
    })

    router.post('/admin/api/account/impersonation/end', async (ctx, next) => {
        await ctx.sessionService.endImpersonation(ctx)
        auditLog(ctx, {}, 'Admin ended impersonation')
        ctx.body = {
            impersonation: null
        }
    })

    router.post('/admin/api/account/approve', async (ctx, next) => {
        const accountId = ctx.request.body.accountId
        await Account.approve(ctx, accountId)
        auditLog(ctx, {accountId}, 'Admin approved user')
        let accounts = await ctx.kubeOIDCUserService.listUsers()
        ctx.body = {
            accounts: accounts.map((acc) => acc.getProfileResponse(true))
        }
    })

    router.post('/admin/api/account/invite', async (ctx, next) => {
        const email = ctx.request.body.email
        if (await Account.findByEmail(ctx, email)) {
            ctx.status = 400
            ctx.body = {
                message: 'Account already exists'
            }
            return
        }
        const account = await Account.createOrUpdateByEmails(ctx, provider, email, undefined, true);
        await Account.approve(ctx, account.accountId)
        auditLog(ctx, {email}, 'Admin invited user')
        let accounts = await ctx.kubeOIDCUserService.listUsers()
        ctx.body = {
            accounts: accounts.map((acc) => acc.getProfileResponse(true))
        }
    })

    return router
}

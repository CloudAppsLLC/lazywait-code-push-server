# CodePush Server

The CodePush Server is a Node.js application that powers the CodePush Service. It allows users to deploy and manage over-the-air updates for their react-native applications in a self-hosted environment.

Please refer to [react-native-code-push](https://github.com/microsoft/react-native-code-push) for instructions on how to onboard your application to CodePush.

## Deployment

### Local

#### Prerequisites

The CodePush Server requires Azure Blob Storage to operate. For the local setup, there is an option to use emulated local storage with Azurite. 
Please follow Azurite [official documentation](https://learn.microsoft.com/en-us/azure/storage/common/storage-use-azurite) to [install](https://learn.microsoft.com/en-us/azure/storage/common/storage-use-azurite?tabs=visual-studio#install-azurite) and [run](https://learn.microsoft.com/en-us/azure/storage/common/storage-use-azurite?tabs=visual-studio#running-azurite-from-the-command-line) it locally.
Additionally, you need to specify [EMULATED](ENVIRONMENT.md#emulated) flag equals true in the environmental variables.

#### Steps
To run the CodePush Server locally, follow these steps:

1. Clone the CodePush Service repository to your local machine.

2. Copy the `.env.example` file to a new file named `.env` in the root directory:
   ````bash
   cp .env.example .env
   ````
   Fill in the values for each environment variable in the `.env` file according to your development or production setup.
3. Install all necessary dependencies:
   ````bash
   npm install
   ````
4. Compile the server code:
   ````bash
   npm run build
   ````
5. Launch the server with the environment-specific start command:
   ````bash
   npm run start:env
   ````

By default, local CodePush server runs on HTTP. To run CodePush Server on HTTPS:

1. Create a `certs` directory and place `cert.key` (private key) and `cert.crt` (certificate) files there.
2. Set environment variable [HTTPS](./ENVIRONMENT.md#https) to true.
 
> **Warning!** When hosting CodePush on Azure App Service HTTPS is enabled by default.

For more detailed instructions and configuration options, please refer to the [ENVIRONMENT.md](./ENVIRONMENT.md) file.

### Azure

CodePush Server is designed to run as [Azure App Service](https://learn.microsoft.com/en-us/azure/app-service/overview).

#### Prerequisites

To deploy CodePush to Azure, an active Azure account and subscription are needed. 
For more information, follow Azure's [official documentation](https://azure.microsoft.com/en-us/get-started/).
During the deployment process, the included bicep script will create bare minimum Azure services needed to run CodePush Server including:
1. Service plan
2. App Service
3. Storage account

Additionally, for interactive user authentication, a GitHub OAuth application is needed. 
More detailed instructions on how to set up one can be found in the section [OAuth Apps](#oauth-apps).

#### Steps

**NOTE** Please be aware of [project-suffix naming limitations](#project-suffix) for resources in Azure .

1. Login to your Azure account: `az login`
2. Select subscription for deployment: `az account set --subscription <subscription-id>`
3. Create resource group for CodePush resources: `az group create --name <resource-group-name> --location <az-location eg. eastus>`
4. Deploy infrastructure with the next command: `az deployment group create --resource-group <resource-group-name> --template-file ./codepush-infrastructure.bicep --parameters project_suffix=<project-suffix> az_location=<az-location eg. eastus> github_client_id=<github-client-id> github_client_secret=<github-client-secret> microsoft_client_id=<microsoft-client-id> microsoft_client_secret=<microsoft-client-secret>`. OAuth parameters (both GitHub and Microsoft) are optional. It is possible to specify them after the deployment in environment settings of Azure WebApp.
5. Deploy CodePush to the Azure WebApp created during infrastructure deployment. Follow the Azure WebApp [official documentation](https://learn.microsoft.com/en-us/azure/app-service/) "Deployment and configuration" section for detailed instructions.

> **Warning!** The created Azure Blob Storage has default access settings. 
> This means that all users within the subscription can access the storage account tables. 
> Adjusting the storage account access settings to ensure proper security is the responsibility of the owner.

## Configure react-native-code-push

In order for [react-native-code-push](https://github.com/microsoft/react-native-code-push) to use your server, additional configuration value is needed.

### Android

in `strings.xml`, add following line, replacing `server-url` with your server.

```
<string moduleConfig="true" name="CodePushServerUrl">server-url</string>
```

### iOS

in `Info.plist` file, add following lines, replacing `server-url` with your server.

```
<key>CodePushServerURL</key>
<string>server-url</string>
```

## OAuth apps

CodePush uses GitHub as its only interactive identity provider, so for browser sign-in you need a GitHub OAuth App registration for CodePush. API calls do not use it at all -- they carry an access key through the bearer strategy (`script/routes/AUTH.md`). 
Client id and client secret created during registration should be provided to the CodePush server in environment variables. 
Below are instructions on how to create OAuth App registrations.

### GitHub

1. Go to https://github.com/settings/developers
1. Click on `New OAuth App`
1. `Homepage URL` parameter will be the same as URL of your CodePush application on Azure - `https://codepush-<project-suffix>.azurewebsites.net` (for local development it will be either http://localhost:3000 or https://localhost:8443)
1. `Authorization callback URL` will be `https://codepush-<project-suffix>.azurewebsites.net/auth/callback/github` (for local development it will be either http://localhost:3000/auth/callback/github or https://localhost:8443/auth/callback/github)

### Microsoft — REMOVED

The `microsoft` (personal) and `azure-ad` (work) providers were deleted when this
fork moved off Azure; they were the last Microsoft identity dependency in the
request path. `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` and
`MICROSOFT_TENANT_ID` are read nowhere and the `/auth/*/microsoft` and
`/auth/*/azure-ad` routes no longer exist.

Accounts that registered through those providers still exist and are still keyed by
email — only the interactive sign-in is gone. See
[`script/routes/AUTH.md`](./script/routes/AUTH.md) for what those developers do
instead, and for how access keys are minted and verified.

## Naming limitations

### project-suffix

1. Only letters are allowed.
1. Maximum 15 characters.

## Metrics

Installation metrics allow monitoring release activity via the CLI. For detailed usage instructions, please refer to the [CLI documentation](../cli/README.md#development-parameter).

Redis is required for Metrics to work.

### Steps

1. Install Redis by following [official installation guide](https://redis.io/docs/latest/operate/oss_and_stack/install/install-redis/).
1. TLS is required. Follow [official Redis TLS run guide](https://redis.io/docs/latest/operate/oss_and_stack/management/security/encryption/#running-manually).
1. Set the necessary environment variables for [Redis](./ENVIRONMENT.md#redis).
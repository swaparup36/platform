/* eslint-disable camelcase */
import {
    ConflictException,
    HttpException,
    Inject,
    Injectable,
    NotFoundException
} from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { BaseService } from 'libs/service/base.service';
import { CredentialDefinitionRepository } from './repositories/credential-definition.repository';
import { CreateCredDefPayload, CredDefPayload, GetAllCredDefsPayload, GetCredDefBySchemaId, GetCredDefPayload, IPlatformCredDefs, ISaveCredDef } from './interfaces/create-credential-definition.interface';
import { credential_definition } from '@prisma/client';
import { ResponseMessages } from '@credebl/common/response-messages';
import { CreateCredDefAgentRedirection, CredDefSchema, GetCredDefAgentRedirection } from './interfaces/credential-definition.interface';
import { map } from 'rxjs/operators';
import { OrgAgentType, SchemaType, SortValue } from '@credebl/enum/enum';
import { Cache } from 'cache-manager';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { ICredDefDetails, IPlatformCredDefsData } from '@credebl/common/interfaces/cred-def.interface';
import { NATSClient } from '@credebl/common/NATSClient';
import { from } from 'rxjs';
import { ISchemaDetail } from '@credebl/common/interfaces/schema.interface';
@Injectable()
export class CredentialDefinitionService extends BaseService {
    constructor(
        private readonly credentialDefinitionRepository: CredentialDefinitionRepository,
        @Inject('NATS_CLIENT') private readonly credDefServiceProxy: ClientProxy,
        @Inject(CACHE_MANAGER) private readonly cacheService: Cache,
        private readonly natsClient : NATSClient

    ) {
        super('CredentialDefinitionService');
    }

    async createCredentialDefinition(payload: CreateCredDefPayload): Promise<credential_definition> {
        try {
            const { credDef, user } = payload;
            const { agentEndPoint, orgDid } = await this.credentialDefinitionRepository.getAgentDetailsByOrgId(credDef.orgId);
            // eslint-disable-next-line yoda
            const did = credDef.orgDid?.split(':').length >= 4 ? credDef.orgDid : orgDid;
            const getAgentDetails = await this.credentialDefinitionRepository.getAgentType(credDef.orgId);
            
            const userId = user.id;
            credDef.tag = credDef.tag.trim();
            const dbResult: credential_definition = await this.credentialDefinitionRepository.getByAttribute(
                credDef.schemaLedgerId,
                credDef.tag
            );

            if (dbResult) {
                throw new ConflictException(ResponseMessages.credentialDefinition.error.Conflict);
            }
            let credDefResponseFromAgentService;

            const orgAgentType = await this.credentialDefinitionRepository.getOrgAgentType(getAgentDetails.org_agents[0].orgAgentTypeId);
            if (OrgAgentType.DEDICATED === orgAgentType) {
                const CredDefPayload = {
                    tag: credDef.tag,
                    schemaId: credDef.schemaLedgerId,
                    issuerId: did,
                    agentEndPoint,
                    orgId: credDef.orgId,
                    agentType: OrgAgentType.DEDICATED
                };

                credDefResponseFromAgentService = await this._createCredentialDefinition(CredDefPayload);

            } else if (OrgAgentType.SHARED === orgAgentType) {
                const { tenantId } = await this.credentialDefinitionRepository.getAgentDetailsByOrgId(credDef.orgId);

                const CredDefPayload = {
                    tenantId,
                    method: 'registerCredentialDefinition',
                    payload: {
                        tag: credDef.tag,
                        schemaId: credDef.schemaLedgerId,
                        issuerId: did
                    },
                    agentEndPoint,
                    orgId: credDef.orgId,
                    agentType: OrgAgentType.SHARED
                };
                credDefResponseFromAgentService = await this._createCredentialDefinition(CredDefPayload);
            }
            const response = JSON.parse(JSON.stringify(credDefResponseFromAgentService.response));
            const schemaDetails = await this.credentialDefinitionRepository.getSchemaById(credDef.schemaLedgerId);
            if (!schemaDetails) {
                throw new NotFoundException(ResponseMessages.credentialDefinition.error.schemaIdNotFound);
            }
            const credDefData: CredDefPayload = {
                tag: '',
                schemaLedgerId: '',
                issuerId: '',
                revocable: credDef.revocable,
                createdBy: `0`,
                lastChangedBy: `0`,
                orgId: '0',
                schemaId: '0',
                credentialDefinitionId: ''
            };

            if ('finished' === response.state) {
                credDefData.tag = response.credentialDefinition.tag;
                credDefData.schemaLedgerId = response.credentialDefinition.schemaId;
                credDefData.issuerId = response.credentialDefinition.issuerId;
                credDefData.credentialDefinitionId = response.credentialDefinitionId;
                credDefData.orgId = credDef.orgId;
                credDefData.revocable = credDef.revocable;
                credDefData.schemaId = schemaDetails.id;
                credDefData.createdBy = userId;
                credDefData.lastChangedBy = userId;
            } else if ('finished' === response.credentialDefinition.state) {
                credDefData.tag = response.credentialDefinition.credentialDefinition.tag;
                credDefData.schemaLedgerId = response.credentialDefinition.credentialDefinition.schemaId;
                credDefData.issuerId = response.credentialDefinition.credentialDefinition.issuerId;
                credDefData.credentialDefinitionId = response.credentialDefinition.credentialDefinitionId;
                credDefData.orgId = credDef.orgId;
                credDefData.revocable = credDef.revocable;
                credDefData.schemaId = schemaDetails.id;
                credDefData.createdBy = userId;
                credDefData.lastChangedBy = userId;
            }
            const credDefResponse = await this.credentialDefinitionRepository.saveCredentialDefinition(credDefData);

            delete credDefResponse.lastChangedBy;
            delete credDefResponse.lastChangedDateTime;

            return credDefResponse;

        } catch (error) {
            this.logger.error(
                `Error in creating credential definition: ${JSON.stringify(error)}`
            );
            if (error && error?.status && error?.status?.message && error?.status?.message?.error) {
                throw new RpcException({
                    message: error?.status?.message?.error?.reason ? error?.status?.message?.error?.reason : error?.status?.message?.error,
                    statusCode: error?.status?.code
                });

            } else {
                throw new RpcException(error.response ? error.response : error);
            }
        }
    }

    async _createCredentialDefinition(payload: CreateCredDefAgentRedirection): Promise<{
        response: string;
    }> {
        try {
            const pattern = {
                cmd: 'agent-create-credential-definition'
            };

            const credDefResponse = await from(this.natsClient
                .send<string>(this.credDefServiceProxy, pattern, payload))
                .pipe(
                    map((response) => (
                        {
                            response
                        }))
                ).toPromise()
                .catch(error => {
                    this.logger.error(`Catch : ${JSON.stringify(error)}`);
                    throw new HttpException(
                        {
                            status: error.statusCode,
                            error: error.message
                        }, error.error);
                });
            return credDefResponse;
        } catch (error) {
            this.logger.error(`Error in creating credential definition : ${JSON.stringify(error)}`);
            throw error;
        }
    }

    async getAllPlatformCredDefs(credDefsPayload: IPlatformCredDefs): Promise<IPlatformCredDefsData> {
        try {
           const { pageSize, pageNumber } = credDefsPayload;
           const response = await this.credentialDefinitionRepository.getAllPlatformCredDefsDetails(credDefsPayload);

           const credDefResponse: IPlatformCredDefsData = {
             totalItems: response.credDefCount,
             hasNextPage: pageSize * pageNumber < response.credDefCount,
             hasPreviousPage: 1 < pageNumber,
             nextPage: pageNumber + 1,
             previousPage: pageNumber - 1,
             lastPage: Math.ceil(response.credDefCount / pageSize),
             data: response.credDefResult
           };

           if (0 !== response.credDefCount) {
             return credDefResponse;
           } else {
             throw new NotFoundException(ResponseMessages.credentialDefinition.error.NotFound);
           }
    
    
        } catch (error) {
          this.logger.error(`Error in retrieving all credential definitions: ${error}`);
          throw new RpcException(error.response ? error.response : error);
        }
      }
    
    async getCredentialDefinitionById(payload: GetCredDefPayload): Promise<credential_definition> {
        try {
            const { credentialDefinitionId, orgId } = payload;
            const { agentEndPoint } = await this.credentialDefinitionRepository.getAgentDetailsByOrgId(String(orgId));
            const getAgentDetails = await this.credentialDefinitionRepository.getAgentType(String(orgId));
            const orgAgentType = await this.credentialDefinitionRepository.getOrgAgentType(getAgentDetails.org_agents[0].orgAgentTypeId);
            
            let  credDefResponse;
            if (OrgAgentType.DEDICATED === orgAgentType) {
                const getSchemaPayload = {
                    credentialDefinitionId,
                    orgId,
                    agentEndPoint,
                    agentType: OrgAgentType.DEDICATED
                };
                credDefResponse = await this._getCredentialDefinitionById(getSchemaPayload);
            } else if (OrgAgentType.SHARED === orgAgentType) {
                const { tenantId } = await this.credentialDefinitionRepository.getAgentDetailsByOrgId(String(orgId));
                const getSchemaPayload = {
                    orgId, 
                    tenantId,
                    method: 'getCredentialDefinitionById',
                    payload: { credentialDefinitionId },
                    agentType: OrgAgentType.SHARED,
                    agentEndPoint
                };
                credDefResponse = await this._getCredentialDefinitionById(getSchemaPayload);
            }
            if (credDefResponse.response.resolutionMetadata.error) {
                throw new NotFoundException(ResponseMessages.credentialDefinition.error.credDefIdNotFound);
            }

            return credDefResponse;
        } catch (error) {
            this.logger.error(`Error retrieving credential definition with id ${payload.credentialDefinitionId}`);
            if (error && error?.status && error?.status?.message && error?.status?.message?.error) {
                throw new RpcException({
                    message: error?.status?.message?.error?.reason ? error?.status?.message?.error?.reason : error?.status?.message?.error,
                    statusCode: error?.status?.code
                });

            } else {
                throw new RpcException(error.response ? error.response : error);
            }
        }
    }

    async _getCredentialDefinitionById(payload: GetCredDefAgentRedirection): Promise<{
        response: string;
    }> {
        
        try {
            const pattern = {
                cmd: 'agent-get-credential-definition'
            };
            const credDefResponse = await from(this.natsClient
                .send<string>(this.credDefServiceProxy, pattern, payload))
                .pipe(
                    map((response) => (
                        {
                            response
                        }))
                ).toPromise()
                .catch(error => {
                    this.logger.error(`Catch : ${JSON.stringify(error)}`);
                    throw new HttpException(
                        {
                            status: error.statusCode,
                            error: error.message
                        }, error.error);
                });
            return credDefResponse;
        } catch (error) {
            this.logger.error(`Error in creating credential definition : ${JSON.stringify(error)}`);
            throw error;
        }
    }

    async getAllCredDefs(payload: GetAllCredDefsPayload): Promise<ICredDefDetails> {
        try {
            const { credDefSearchCriteria, orgId } = payload;
            const response = await this.credentialDefinitionRepository.getAllCredDefs(credDefSearchCriteria, orgId);
    
            const schemaIds = response?.map((item) => item?.schemaLedgerId);
    
            const schemaDetails = await this._getSchemaDetails(schemaIds);
    
            const archivedSchemaIds = schemaDetails
                .filter((schema) => schema.isSchemaArchived)
                .map((schema) => schema.schemaLedgerId);   
    
            const filteredResponse = response.filter(
                (credDef) => !archivedSchemaIds.includes(credDef.schemaLedgerId)
            );
    
            const credDefResponse = {
                totalItems: filteredResponse.length,
                hasNextPage: credDefSearchCriteria.pageSize * credDefSearchCriteria.pageNumber < response.length,
                hasPreviousPage: 1 < credDefSearchCriteria.pageNumber,
                nextPage: credDefSearchCriteria.pageNumber + 1,
                previousPage: credDefSearchCriteria.pageNumber - 1,
                lastPage: Math.ceil(response.length / credDefSearchCriteria.pageSize),
                data: filteredResponse
            };
    
            if (0 === filteredResponse.length) {
                throw new NotFoundException(ResponseMessages.credentialDefinition.error.NotFound);
            }
    
            return credDefResponse;
        } catch (error) {
            this.logger.error(`Error in retrieving credential definitions: ${error}`);
            throw new RpcException(error.response ? error.response : error);
        }
    }
    
    async _getSchemaDetails(schemaIds: string[]): Promise<ISchemaDetail[]> {
        const pattern = { cmd: 'get-schemas-details' };
      
        const payload = {
            templateIds: schemaIds
        };

        const getSchemaDetails = await this.credDefServiceProxy
          .send(pattern, payload)
          .toPromise()
          .catch((error) => {
            this.logger.error(`catch: ${JSON.stringify(error)}`);
            throw new HttpException(
              {
                status: error.status,
                error: error.message
              },
              error.status
            );
          });
        return getSchemaDetails;
      }

    async getCredentialDefinitionBySchemaId(payload: GetCredDefBySchemaId): Promise<credential_definition[]> {
        try {
            const { schemaId } = payload;
            const credDefListBySchemaId = await this.credentialDefinitionRepository.getCredentialDefinitionBySchemaId(schemaId);
            return credDefListBySchemaId;
        } catch (error) {
            this.logger.error(`Error in retrieving credential definitions: ${error}`);
            throw new RpcException(error.response ? error.response : error);
        }
    }

    async getAllCredentialTemplates(orgId: string, schemaType: string): Promise<CredDefSchema[]> {
        const schemaTypeEnum = schemaType as SchemaType;
        if (!Object.values(SchemaType).includes(schemaTypeEnum)) {
            throw new NotFoundException(ResponseMessages.credentialDefinition.error.InvalidSchemaType);
        }
        try {
            const payload = {
                orgId,
                sortValue: SortValue.ASC,
                credDefSortBy: 'id'
            };

            if (schemaType === SchemaType.W3C_Schema) {
                const schemaDetailList =  await this.credentialDefinitionRepository.getAllSchemaByOrgIdAndType(orgId, schemaType);
                const schemaResponse = await Promise.all(schemaDetailList.map(async (schemaDetails) => ({
                    schemaCredDefName: `${schemaDetails.name}-${schemaDetails.version}`,
                    schemaName: schemaDetails.name,
                    schemaVersion: schemaDetails.version,
                    schemaAttributes: schemaDetails.attributes,
                    type: SchemaType.W3C_Schema,
                    schemaIdentifier: schemaDetails.schemaLedgerId,
                    createDateTime: schemaDetails.createDateTime,
                    organizationName: schemaDetails?.organisation?.name,
                    userName: schemaDetails?.organisation?.userOrgRoles[0]?.user?.firstName
                })));
                
                return schemaResponse;
            }
            const credDefSchemaList =
                await this.credentialDefinitionRepository.getAllCredDefsByOrgIdForBulk(
                    payload
                );
 
            if (!credDefSchemaList) {
                throw new NotFoundException(ResponseMessages.credentialDefinition.error.NotFound);
            }

            const activeCredDefSchemaList = credDefSchemaList.filter((item) => !item?.['isSchemaArchived']);
            
            return activeCredDefSchemaList;
        } catch (error) {
            this.logger.error(
                `get Cred-Defs and schema List By OrgId for bulk operations: ${JSON.stringify(error)}`
            );
            if (error?.status?.message?.error) {
                const reason = error?.status?.message?.error?.reason ?? error?.status?.message?.error;
                throw new RpcException({
                    message: reason,
                    statusCode: error?.status?.code
                });
            } else {
                throw new RpcException(error.response ?? error);
            }         
        }
    }

  async _getOrgAgentApiKey(orgId: string): Promise<string> {
    const pattern = { cmd: 'get-org-agent-api-key' };
    const payload = { orgId };

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const message = await this.natsClient.send<any>(this.credDefServiceProxy, pattern, payload);
      return message;
    } catch (error) {
      this.logger.error(`catch: ${JSON.stringify(error)}`);
      throw new HttpException({
        status: error.status,
        error: error.message
      }, error.status);
    }
  }

  async storeCredDefRecord(credDefDetails: ISaveCredDef): Promise<credential_definition> {
    try {
      const schemaSearchResult = await this.credentialDefinitionRepository.storeCredDefRecord(credDefDetails);
      return schemaSearchResult;
    } catch (error) {
      this.logger.error(`Error in getSchemaBySchemaId: ${error}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }
}
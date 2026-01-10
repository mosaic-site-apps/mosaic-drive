use aws_sdk_s3::Client;
use aws_config::meta::region::RegionProviderChain;
use aws_config::BehaviorVersion;
use aws_sdk_s3::config::Region;
use std::time::Duration;

pub struct S3Client {
    pub client: Client,
}

impl S3Client {
    pub async fn new(access_key: String, secret_key: String, endpoint: String, region: Option<String>) -> Result<Self, anyhow::Error> {
        let credentials = aws_credential_types::Credentials::new(
            access_key,
            secret_key,
            None,
            None,
            "Static",
        );

        let region_provider = RegionProviderChain::first_try(
            region.map(Region::new).unwrap_or(Region::new("us-east-1"))
        );

        // Configure longer timeouts for large file operations
        let timeout_config = aws_config::timeout::TimeoutConfig::builder()
            .operation_timeout(Duration::from_secs(300))      // 5 min per operation
            .operation_attempt_timeout(Duration::from_secs(120)) // 2 min per attempt
            .connect_timeout(Duration::from_secs(30))         // 30s to connect
            .build();

        let config = aws_config::defaults(BehaviorVersion::latest())
            .credentials_provider(credentials)
            .region(region_provider)
            .timeout_config(timeout_config)
            .load()
            .await;

        let s3_config_builder = aws_sdk_s3::config::Builder::from(&config)
            .endpoint_url(endpoint)
            .force_path_style(true);

        let client = Client::from_conf(s3_config_builder.build());

        Ok(Self { client })
    }
}
